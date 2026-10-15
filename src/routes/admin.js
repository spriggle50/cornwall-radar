// Logged-in admin panel — a second way to do the exact same moderation as
// the emailed one-click links (business.js's and reviews.js's own
// /admin/review/:id + /admin/remove/:id routes), for when Ady is signed in
// but can't find or doesn't have the original email to hand. Same admin
// identity (ADMIN_ALERT_EMAIL, see middleware/requireAdmin.js) and the same
// underlying delete — this is not a second, separate moderation system,
// just a second door into the same one. Behind requireAuth + requireAdmin
// on every route in this file.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');
const { geocodeLocation } = require('../fetchers/geocode');
const { nearestTown } = require('../lib/cornwallTowns');
const { BUSINESS_CATEGORIES } = require('../lib/businessCategories');

router.use(requireAuth, requireAdmin);

// Same tiny helper as business.js's own listing-save route — duplicated
// rather than imported, matching this project's habit of keeping a few
// lines of route-local logic local rather than adding a cross-file
// dependency just to share it (see business.js's own copy for the same
// reasoning, and index.html's client-side copy for the third instance).
function normalizeWebsiteUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
}

// Same voucher rules as business.js's own PUT /listing — a voucher needs a
// title, an optional description/expiry ride along with it, and an expiry
// (if set) has to be a real, future date. Returns { error } on a bad
// input, or { voucher_title, voucher_description, voucher_expires_at }
// ready to drop straight into an insert/update payload. Added so Ady can
// set a voucher for a business that replied by email and has no reason to
// ever sign in and do it themselves — this was previously owner-only.
function cleanVoucherFields({ voucherTitle, voucherDescription, voucherExpiresAt }) {
  const voucher_title = (voucherTitle || '').trim() || null;
  const voucher_description = (voucherDescription || '').trim() || null;
  const voucher_expires_at = (voucherExpiresAt || '').trim() || null;
  if (!voucher_title && (voucher_description || voucher_expires_at)) {
    return { error: 'A voucher needs a short title' };
  }
  if (voucher_expires_at) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(voucher_expires_at) || Number.isNaN(Date.parse(voucher_expires_at))) {
      return { error: 'Voucher expiry must be a valid date' };
    }
    if (voucher_expires_at < todayKey) {
      return { error: 'Voucher expiry date must be in the future' };
    }
  }
  return { voucher_title, voucher_description, voucher_expires_at };
}

// GET /api/admin/businesses — every business listing, newest first. Includes
// the owner's login email (same information the emailed moderation link
// already shows) — this endpoint only ever answers to the admin, so there's
// no privacy concern in exposing it here that doesn't already exist there.
// phone/website are included too now, on top of what was already returned,
// so the admin panel's edit form (see PUT below) can pre-fill them.
router.get('/businesses', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('businesses')
      .select('id, name, category, secondary_category, postcode, town, email, phone, website, subscription_status, voucher_title, voucher_description, voucher_expires_at, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ businesses: data || [] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load listings' });
  }
});

// POST /api/admin/businesses — creates a listing on a business's behalf,
// for someone who replied to an outreach email asking to be added rather
// than signing up and doing it themselves through routes/business.js's own
// PUT /listing.
//
// businesses.id has a foreign-key constraint against auth.users (same as
// every listing created the normal way, where id === the owner's auth user
// id) — a plain generated UUID violates it (businesses_id_fkey). So this
// creates a confirmed, passwordless Supabase Auth user for their email
// first and uses THAT id. That's not just working around the constraint:
// it means the business can later sign in with the normal magic link on
// cornwallradar.co.uk and land on this exact account/listing — no
// separate "claim" flow needed, because the account already exists, just
// dormant until they use it.
router.post('/businesses', async (req, res) => {
  const { name, category, secondaryCategory, phone, website, email, postcode, description, voucherTitle, voucherDescription, voucherExpiresAt } = req.body || {};
  if (!name || !name.trim() || !postcode || !postcode.trim()) {
    return res.status(400).json({ error: 'A business name and postcode/town are both required' });
  }
  if (!category || !BUSINESS_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Choose a category from the list' });
  }
  const cleanSecondaryCategory = (secondaryCategory || '').trim() || null;
  if (cleanSecondaryCategory && !BUSINESS_CATEGORIES.includes(cleanSecondaryCategory)) {
    return res.status(400).json({ error: 'Choose a secondary category from the list, or leave it blank' });
  }
  if (cleanSecondaryCategory && cleanSecondaryCategory === category) {
    return res.status(400).json({ error: 'Secondary category must be different from the main category' });
  }
  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'A contact email is required' });
  }
  const voucherFields = cleanVoucherFields({ voucherTitle, voucherDescription, voucherExpiresAt });
  if (voucherFields.error) {
    return res.status(400).json({ error: voucherFields.error });
  }

  try {
    const emailLower = email.trim().toLowerCase();

    // Catches the obvious accidental-duplicate case — adding the same
    // business twice because an earlier reply was forgotten about — without
    // trying to be a general dedupe system (a business with more than one
    // real email, or a slightly different spelling, won't be caught here).
    const { data: existing } = await supabaseAdmin
      .from('businesses')
      .select('id, name')
      .eq('email', emailLower)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({ error: `A listing already exists for this email (${existing.name}) — edit that one instead.` });
    }

    // Get (or create) the Auth user this listing's id has to point at.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: emailLower,
      email_confirm: true,
    });

    let ownerId = created?.user?.id;
    if (!ownerId) {
      // An account for this email already exists — e.g. they signed up at
      // some point (consumer or business) but never finished adding a
      // listing. Reuse it instead of erroring, so this attaches to their
      // real account rather than failing outright. The admin API has no
      // email-filter on listUsers in this supabase-js version, so this
      // pages through and matches client-side — fine at this project's
      // scale; revisit if the user count gets into the thousands.
      const isDuplicate = createErr && (createErr.code === 'email_exists' || /already.*registered|already.*exists/i.test(createErr.message || ''));
      if (!isDuplicate) throw new Error(createErr?.message || 'Could not create an account for this email');

      for (let page = 1; page <= 5 && !ownerId; page += 1) {
        const { data: pageData, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        if (listErr) throw new Error(listErr.message);
        const match = (pageData?.users || []).find((u) => (u.email || '').toLowerCase() === emailLower);
        if (match) ownerId = match.id;
        if (!pageData?.users?.length || pageData.users.length < 1000) break;
      }
      if (!ownerId) {
        throw new Error(`An account for ${emailLower} already exists but couldn't be looked up — try again, or check Supabase Auth directly.`);
      }
    }

    const geo = await geocodeLocation(postcode);
    const town = nearestTown(geo.lat, geo.lon);

    const { data, error } = await supabaseAdmin
      .from('businesses')
      .insert({
        id: ownerId,
        name: name.trim(),
        category: category.trim(),
        secondary_category: cleanSecondaryCategory,
        description: (description || '').trim() || null,
        phone: (phone || '').trim() || null,
        website: normalizeWebsiteUrl(website),
        email: emailLower,
        postcode: postcode.trim(),
        lat: geo.lat,
        lng: geo.lon,
        town: town ? town.name : null,
        subscription_status: 'free',
        voucher_title: voucherFields.voucher_title,
        voucher_description: voucherFields.voucher_description,
        voucher_expires_at: voucherFields.voucher_expires_at,
      })
      .select('id, name, category, secondary_category, postcode, town, email, phone, website, subscription_status, voucher_title, voucher_description, voucher_expires_at, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not create the listing — check the postcode/town is valid' });
  }
});

// PUT /api/admin/businesses/:id — lets Ady fix a business's own basic
// details on their behalf (a mistyped website was the original case this
// was built for) without the owner needing to sign in and do it themselves.
// Covers name, category, secondary category, phone, website, postcode, the
// account's contact email, and the voucher — NOT logo/description/
// vacancies, which stay owner-only edits via routes/business.js so a
// business's own richer content is never silently touched by anyone but
// them. The voucher's the one exception: added so Ady can set one for a
// business that has no reason to ever sign in and do it themselves (see
// POST above). `email` here is businesses.email — the contact address
// shown in this admin list — NOT the owner's actual Supabase Auth sign-in,
// which can't be (and doesn't need to be) changed from here.
router.put('/businesses/:id', async (req, res) => {
  const { name, category, secondaryCategory, phone, website, email, postcode, voucherTitle, voucherDescription, voucherExpiresAt } = req.body || {};
  if (!name || !name.trim() || !postcode || !postcode.trim()) {
    return res.status(400).json({ error: 'A business name and postcode/town are both required' });
  }
  if (!category || !BUSINESS_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Choose a category from the list' });
  }
  const cleanSecondaryCategory = (secondaryCategory || '').trim() || null;
  if (cleanSecondaryCategory && !BUSINESS_CATEGORIES.includes(cleanSecondaryCategory)) {
    return res.status(400).json({ error: 'Choose a secondary category from the list, or leave it blank' });
  }
  if (cleanSecondaryCategory && cleanSecondaryCategory === category) {
    return res.status(400).json({ error: 'Secondary category must be different from the main category' });
  }
  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'A contact email is required' });
  }
  const voucherFields = cleanVoucherFields({ voucherTitle, voucherDescription, voucherExpiresAt });
  if (voucherFields.error) {
    return res.status(400).json({ error: voucherFields.error });
  }

  try {
    // Same re-geocode-on-every-save approach as business.js's own PUT
    // /listing — simpler than trying to detect "did the postcode actually
    // change" and cheap enough (geocodeLocation has its own caching) not to
    // matter.
    const geo = await geocodeLocation(postcode);
    const town = nearestTown(geo.lat, geo.lon);

    const { data, error } = await supabaseAdmin
      .from('businesses')
      .update({
        name: name.trim(),
        category: category.trim(),
        secondary_category: cleanSecondaryCategory,
        phone: (phone || '').trim() || null,
        website: normalizeWebsiteUrl(website),
        email: email.trim(),
        postcode: postcode.trim(),
        lat: geo.lat,
        lng: geo.lon,
        town: town ? town.name : null,
        voucher_title: voucherFields.voucher_title,
        voucher_description: voucherFields.voucher_description,
        voucher_expires_at: voucherFields.voucher_expires_at,
      })
      .eq('id', req.params.id)
      .select('id, name, category, secondary_category, postcode, town, email, phone, website, subscription_status, voucher_title, voucher_description, voucher_expires_at, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save changes — check the postcode/town is valid' });
  }
});

// DELETE /api/admin/businesses/:id — same effect as clicking "Remove this
// listing" on the emailed moderation page, just reachable while signed in.
router.delete('/businesses/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('businesses').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove listing' });
  }
});

// GET /api/admin/reviews — every review across every business, newest
// first, with the business name and reviewer's login email attached. Joined
// in JS from three separate queries (business_reviews, then businesses and
// consumers batched by id) rather than a PostgREST embedded select, matching
// this project's established "logic in JS, not in the query layer" approach
// (see lib/supabaseClient.js's module comment, and reviews.js's own admin
// route which does the same two-lookup pattern for a single review).
router.get('/reviews', async (req, res) => {
  try {
    const { data: reviews, error } = await supabaseAdmin
      .from('business_reviews')
      .select('id, business_id, consumer_id, rating, comment, reply, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const rows = reviews || [];
    const businessIds = [...new Set(rows.map((r) => r.business_id))];
    const consumerIds = [...new Set(rows.map((r) => r.consumer_id))];

    const [{ data: businesses }, { data: consumers }] = await Promise.all([
      businessIds.length
        ? supabaseAdmin.from('businesses').select('id, name').in('id', businessIds)
        : Promise.resolve({ data: [] }),
      consumerIds.length
        ? supabaseAdmin.from('consumers').select('id, email').in('id', consumerIds)
        : Promise.resolve({ data: [] }),
    ]);
    const businessNames = Object.fromEntries((businesses || []).map((b) => [b.id, b.name]));
    const consumerEmails = Object.fromEntries((consumers || []).map((c) => [c.id, c.email]));

    const result = rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      businessName: businessNames[r.business_id] || 'Unknown business',
      reviewerEmail: consumerEmails[r.consumer_id] || 'unknown',
      rating: r.rating,
      comment: r.comment,
      reply: r.reply,
      createdAt: r.created_at,
    }));
    res.json({ reviews: result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load reviews' });
  }
});

// DELETE /api/admin/reviews/:id — same effect as the emailed moderation
// page's "Remove this review".
router.delete('/reviews/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('business_reviews').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove review' });
  }
});

module.exports = router;
