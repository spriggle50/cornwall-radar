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
      .select('id, name, category, postcode, email, phone, website, subscription_status, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ businesses: data || [] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load listings' });
  }
});

// PUT /api/admin/businesses/:id — lets Ady fix a business's own basic
// details on their behalf (a mistyped website was the original case this
// was built for) without the owner needing to sign in and do it themselves.
// Deliberately limited to the fields most likely to need a quick correction
// — name, category, phone, website, postcode, and the account's contact
// email — NOT logo/description/voucher/vacancies, which stay owner-only
// edits via routes/business.js so a business's own richer content is never
// silently touched by anyone but them. `email` here is businesses.email —
// the contact address shown in this admin list — NOT the owner's actual
// Supabase Auth sign-in, which can't be (and doesn't need to be) changed
// from here.
router.put('/businesses/:id', async (req, res) => {
  const { name, category, phone, website, email, postcode } = req.body || {};
  if (!name || !name.trim() || !postcode || !postcode.trim()) {
    return res.status(400).json({ error: 'A business name and postcode/town are both required' });
  }
  if (!category || !BUSINESS_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Choose a category from the list' });
  }
  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'A contact email is required' });
  }

  try {
    // Same re-geocode-on-every-save approach as business.js's own PUT
    // /listing — simpler than trying to detect "did the postcode actually
    // change" and cheap enough (geocodeLocation has its own caching) not to
    // matter.
    const geo = await geocodeLocation(postcode);

    const { data, error } = await supabaseAdmin
      .from('businesses')
      .update({
        name: name.trim(),
        category: category.trim(),
        phone: (phone || '').trim() || null,
        website: normalizeWebsiteUrl(website),
        email: email.trim(),
        postcode: postcode.trim(),
        lat: geo.lat,
        lng: geo.lon,
      })
      .eq('id', req.params.id)
      .select('id, name, category, postcode, email, phone, website, subscription_status, created_at')
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
