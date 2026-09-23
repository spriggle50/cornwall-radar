// Business directory — self-service listings for local businesses. This is
// a separate table (`businesses`, see schema.sql) from the consumer
// accounts in account.js/billing.js, but NOT a separate sign-in system —
// the exact same Supabase Auth magic-link session and requireAuth
// middleware work here too, so a person can be both a paying subscriber
// AND a listed business with one login. "Which kind of account is this?"
// is just "which table has a row for this auth user id", not a different
// auth flow.
//
// Every listing is free and public the moment it's created (see
// routes/directory.js for the public, no-auth-required browse endpoint).
// Paying upgrades a listing to "Featured" (subscription_status: 'active'),
// which the directory sorts first. Reuses the same Stripe
// checkout-session/billing-portal pattern as the consumer billing in
// billing.js, just against a second price (STRIPE_BUSINESS_PRICE_ID) and a
// second table — see billing.js's webhookHandler for how the one shared
// Stripe webhook endpoint tells a business subscription event apart from a
// consumer one (it can't just go by the account id alone, since the same
// person's auth id could exist in both tables).
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { stripe } = require('../lib/stripeClient');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');
const { geocodeLocation } = require('../fetchers/geocode');
const { BUSINESS_CATEGORIES } = require('../lib/businessCategories');
const { sendEmail, isConfigured: emailConfigured } = require('../lib/emailClient');

// Logos are small and few (one per business), so memory storage + a
// straight-through upload to Supabase Storage is simpler than juggling temp
// files on disk — the file never needs to touch this server's own
// filesystem. 2MB is generous for a logo while still keeping the free
// SMTP2GO-style "don't need to think about disk space" simplicity the rest
// of this project favours.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});
const ALLOWED_LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const STRIPE_BUSINESS_PRICE_ID = process.env.STRIPE_BUSINESS_PRICE_ID;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

// Admin moderation — see the /admin routes below. Both are opt-in: leave
// either unset and the "new listing" email in PUT /listing simply isn't
// sent (there'd be nothing safe to link to without a token anyway).
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL;
const ADMIN_ACTION_TOKEN = process.env.ADMIN_ACTION_TOKEN;

const escHtml = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Business owners naturally type "trustedtech.uk.com" rather than
// "https://trustedtech.uk.com" — without a scheme, an <a href="..."> built
// from that is a RELATIVE link, so a visitor clicking it on
// cornwallradar.co.uk ends up requesting cornwallradar.co.uk/trustedtech.uk.com
// from our own server instead of leaving the site, and sees Express's
// "Cannot GET" 404. Fixing this on save (rather than only at render time)
// means every place that ever displays business.website — the directory
// row, the admin email, the account panel preview — gets a working link
// for free, with no per-view special-casing needed.
function normalizeWebsiteUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
}

// ── Admin moderation: new-listing alert + one-click review/removal ────────
// Listings go live instantly with no approval gate (see PUT /listing) —
// this is "notify, then remove after the fact if needed" rather than
// holding every listing for approval first. There's no admin-role concept
// anywhere in this project's Supabase Auth, so these two routes are
// deliberately NOT behind requireAuth — they're gated by a long random
// shared secret (ADMIN_ACTION_TOKEN) known only to Ady, via the link in
// the alert email, instead.
//
// The review step is a separate GET (safe, read-only) from the actual
// delete (POST, only reachable by clicking the button on that page) on
// purpose: some email clients and security scanners pre-fetch links in an
// email to check them before a person ever clicks, so a plain GET link
// that deleted the listing directly could get it removed automatically
// before Ady even opens the email.
function requireAdminToken(req, res, next) {
  if (!ADMIN_ACTION_TOKEN || req.query.token !== ADMIN_ACTION_TOKEN) {
    return res.status(403).send('Not authorized.');
  }
  next();
}

router.get('/admin/review/:id', requireAdminToken, async (req, res) => {
  const { data: business, error } = await supabaseAdmin
    .from('businesses')
    .select('id, name, category, description, phone, website, postcode, email, subscription_status')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !business) {
    return res.status(404).send('<p style="font-family: -apple-system, sans-serif;">Listing not found — it may already have been removed.</p>');
  }

  const removeUrl = `/api/business/admin/remove/${encodeURIComponent(business.id)}?token=${encodeURIComponent(req.query.token)}`;
  res.send(`
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; color:#12181a; line-height:1.5;">
      <h2 style="margin-bottom:4px;">${escHtml(business.name)}</h2>
      <p style="color:#5b6b6a; margin-top:0;">${escHtml(business.category)} · ${escHtml(business.postcode)}</p>
      ${business.description ? `<p>${escHtml(business.description)}</p>` : ''}
      ${business.phone ? `<p><strong>Phone:</strong> ${escHtml(business.phone)}</p>` : ''}
      ${business.website ? `<p><strong>Website:</strong> ${escHtml(business.website)}</p>` : ''}
      <p><strong>Owner's login email:</strong> ${escHtml(business.email)}</p>
      <p><strong>Status:</strong> ${escHtml(business.subscription_status)}</p>
      <form method="POST" action="${removeUrl}" onsubmit="return confirm('Remove this listing from the directory? This can\\'t be undone.');">
        <button type="submit" style="background:#c0392b; color:#fff; border:none; padding:10px 20px; border-radius:6px; font-size:1em; cursor:pointer;">Remove this listing</button>
      </form>
    </div>
  `);
});

router.post('/admin/remove/:id', requireAdminToken, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('businesses').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.send('<p style="font-family: -apple-system, sans-serif;">Listing removed.</p>');
  } catch (err) {
    res.status(500).send('<p style="font-family: -apple-system, sans-serif;">Could not remove listing: ' + escHtml(err.message || 'unknown error') + '</p>');
  }
});

router.use(requireAuth);

// GET /api/business/me — the signed-in user's own listing, or null if they
// haven't created one yet. Unlike ensureConsumer in account.js, no row is
// auto-created just from signing in — a half-empty public listing with no
// name/category isn't useful to anyone, so the row only appears once the
// business actually fills in the form (PUT /listing below).
router.get('/me', async (req, res) => {
  try {
    const { data: business, error } = await supabaseAdmin
      .from('businesses')
      .select('id, name, category, description, phone, website, postcode, lat, lng, logo_url, subscription_status, voucher_title, voucher_description, voucher_expires_at')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ email: req.user.email, business });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load your listing' });
  }
});

// PUT /api/business/listing — create or update the caller's own listing.
// One row per business owner — saving always replaces the existing details
// rather than managing a list, same simplicity as the morning-digest
// preference in account.js. stripe_customer_id/subscription_status are
// preserved across edits (a business editing their opening hours shouldn't
// lose their Featured status).
router.put('/listing', async (req, res) => {
  const { name, category, description, phone, website, postcode, voucherTitle, voucherDescription, voucherExpiresAt } = req.body || {};
  if (!name || !name.trim() || !postcode || !postcode.trim()) {
    return res.status(400).json({ error: 'A business name, category and postcode/town are all required' });
  }
  // Category used to be free text — now it's a fixed list (see
  // lib/businessCategories.js) so the directory's filter dropdown has a
  // consistent, non-duplicated set of values to offer instead of however
  // each business happened to spell their trade.
  if (!category || !BUSINESS_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Choose a category from the list' });
  }

  // Voucher fields are optional and open to every category (not just Days
  // Out & Attractions) — see routes/directory.js's ?voucher=1 filter and
  // schema.sql's businesses.voucher_* columns. Same "editing always
  // replaces" shape as the rest of this form: leaving voucherTitle blank
  // clears any existing voucher rather than needing a separate "remove
  // voucher" action.
  const cleanVoucherTitle = (voucherTitle || '').trim() || null;
  const cleanVoucherDescription = (voucherDescription || '').trim() || null;
  let cleanVoucherExpiresAt = (voucherExpiresAt || '').trim() || null;
  if (!cleanVoucherTitle && (cleanVoucherDescription || cleanVoucherExpiresAt)) {
    return res.status(400).json({ error: 'A voucher needs a short title' });
  }
  if (cleanVoucherExpiresAt) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanVoucherExpiresAt) || Number.isNaN(Date.parse(cleanVoucherExpiresAt))) {
      return res.status(400).json({ error: 'Voucher expiry must be a valid date' });
    }
    if (cleanVoucherExpiresAt < todayKey) {
      return res.status(400).json({ error: 'Voucher expiry date must be in the future' });
    }
  }

  try {
    const geo = await geocodeLocation(postcode);

    const { data: existing } = await supabaseAdmin
      .from('businesses')
      .select('stripe_customer_id, subscription_status, logo_url')
      .eq('id', req.user.id)
      .maybeSingle();

    const { data, error } = await supabaseAdmin
      .from('businesses')
      .upsert({
        id: req.user.id,
        email: req.user.email,
        name: name.trim(),
        category: category.trim(),
        description: (description || '').trim() || null,
        phone: (phone || '').trim() || null,
        website: normalizeWebsiteUrl(website),
        postcode: postcode.trim(),
        lat: geo.lat,
        lng: geo.lon,
        logo_url: existing ? existing.logo_url : null,
        stripe_customer_id: existing ? existing.stripe_customer_id : null,
        subscription_status: existing ? existing.subscription_status : 'free',
        voucher_title: cleanVoucherTitle,
        voucher_description: cleanVoucherDescription,
        voucher_expires_at: cleanVoucherExpiresAt,
      })
      .select('id, name, category, description, phone, website, postcode, lat, lng, logo_url, subscription_status, voucher_title, voucher_description, voucher_expires_at')
      .single();
    if (error) throw new Error(error.message);

    // Only on genuine creation (no `existing` row before this upsert), not
    // on every edit of an already-listed business — otherwise fixing a typo
    // in your phone number would re-alert Ady every time. Fire-and-forget:
    // a slow or misconfigured mailbox should never delay or fail the
    // business owner's own save.
    if (!existing && ADMIN_ALERT_EMAIL && ADMIN_ACTION_TOKEN && emailConfigured()) {
      const reviewUrl = `${APP_BASE_URL}/api/business/admin/review/${data.id}?token=${encodeURIComponent(ADMIN_ACTION_TOKEN)}`;
      sendEmail({
        to: ADMIN_ALERT_EMAIL,
        subject: `New business listing: ${data.name}`,
        html: `
          <div style="font-family: -apple-system, sans-serif; color:#12181a;">
            <p>A new business listing just went live on Cornwall Radar:</p>
            <p><strong>${escHtml(data.name)}</strong> — ${escHtml(data.category)} — ${escHtml(data.postcode)}</p>
            ${data.description ? `<p>${escHtml(data.description)}</p>` : ''}
            <p><a href="${reviewUrl}">Review it, and remove if needed →</a></p>
          </div>
        `,
      }).catch((e) => console.error('[business] new-listing alert email failed:', e.message));
    }

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save your listing — check the postcode/town is valid' });
  }
});

// DELETE /api/business/listing — remove the caller's listing from the
// directory entirely (not just un-feature it). Doesn't touch an active
// Stripe subscription automatically — same "cancel via the billing portal"
// pattern as the rest of the site, so a business doesn't get surprised by
// their listing vanishing but billing continuing, or vice versa.
router.delete('/listing', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('businesses')
      .delete()
      .eq('id', req.user.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove your listing' });
  }
});

// POST /api/business/logo — upload/replace the caller's logo. Requires a
// listing to already exist (PUT /listing first), since the logo just
// updates that row's logo_url — same "create the listing, then enhance it"
// order as upgrading to Featured. Uploaded to a "business-logos" Storage
// bucket (create this once in the Supabase dashboard, set to Public so the
// directory can display images via their public URL) using the
// service-role client, so no Storage RLS policies are needed — only this
// server ever writes to it, and only after requireAuth has already
// confirmed who's asking.
router.post('/logo', upload.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (field name must be "logo")' });
  }
  const ext = ALLOWED_LOGO_TYPES[req.file.mimetype];
  if (!ext) {
    return res.status(400).json({ error: 'Logo must be a PNG, JPEG or WebP image' });
  }

  try {
    const { data: business } = await supabaseAdmin
      .from('businesses')
      .select('id')
      .eq('id', req.user.id)
      .maybeSingle();
    if (!business) {
      return res.status(400).json({ error: 'Create your listing first, then upload a logo' });
    }

    // upsert: true + a fixed filename (not the original filename) means a
    // second upload cleanly replaces the first rather than accumulating old
    // logos in storage every time someone changes their image.
    const path = `${req.user.id}/logo.${ext}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('business-logos')
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (uploadErr) throw new Error(uploadErr.message);

    const { data: publicUrlData } = supabaseAdmin.storage.from('business-logos').getPublicUrl(path);
    // Cache-bust the URL with a timestamp — the path itself never changes
    // (upsert reuses it), so without this a browser that already cached the
    // old logo image would keep showing it after a replace.
    const logoUrl = publicUrlData.publicUrl + '?v=' + Date.now();

    const { data, error } = await supabaseAdmin
      .from('businesses')
      .update({ logo_url: logoUrl })
      .eq('id', req.user.id)
      .select('id, logo_url')
      .single();
    if (error) throw new Error(error.message);

    res.json(data);
  } catch (err) {
    console.error('[business] logo upload failed:', err.message);
    res.status(500).json({ error: err.message || 'Could not upload logo' });
  }
});

function requireBusinessStripeConfigured(req, res, next) {
  if (!stripe || !STRIPE_BUSINESS_PRICE_ID) {
    return res.status(503).json({ error: 'Featured-listing billing is not configured on this server yet (STRIPE_BUSINESS_PRICE_ID missing).' });
  }
  next();
}

// POST /api/business/create-checkout-session — upgrades the caller's
// listing to Featured. Requires a listing to already exist (PUT /listing
// first) so there's something to feature.
router.post('/create-checkout-session', requireBusinessStripeConfigured, async (req, res) => {
  try {
    const { data: business } = await supabaseAdmin
      .from('businesses')
      .select('id, stripe_customer_id')
      .eq('id', req.user.id)
      .maybeSingle();
    if (!business) {
      return res.status(400).json({ error: 'Create your listing first, then upgrade to Featured' });
    }

    const hasStripeCustomer = !!business.stripe_customer_id;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_BUSINESS_PRICE_ID, quantity: 1 }],
      customer: hasStripeCustomer ? business.stripe_customer_id : undefined,
      customer_email: hasStripeCustomer ? undefined : req.user.email,
      client_reference_id: req.user.id,
      // Tags this checkout — and, via subscription_data below, the
      // subscription it creates — as a BUSINESS purchase. The shared
      // webhook in billing.js reads this to know whether to update
      // `businesses` or `consumers`, since client_reference_id alone
      // (the auth user id) can't disambiguate: the same person could have
      // a row in both tables. Only checkout.session.completed needs this —
      // every later event (renewals, cancellation) is matched by Stripe's
      // own customer id instead, which is never shared between the two
      // tables since each gets its own freshly-created Stripe customer.
      metadata: { accountType: 'business' },
      subscription_data: { metadata: { accountType: 'business' } },
      success_url: `${APP_BASE_URL}/?businessBilling=success`,
      cancel_url: `${APP_BASE_URL}/?businessBilling=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[business] checkout session failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// POST /api/business/create-portal-session — lets a Featured business
// manage or cancel their listing subscription on Stripe's own hosted page.
router.post('/create-portal-session', requireBusinessStripeConfigured, async (req, res) => {
  try {
    const { data: business, error } = await supabaseAdmin
      .from('businesses')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!business || !business.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found yet — upgrade to Featured first' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: business.stripe_customer_id,
      return_url: `${APP_BASE_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[business] portal session failed:', err.message);
    res.status(500).json({ error: 'Could not open the billing portal' });
  }
});

// GET /api/business/reviews — the caller's OWN business's reviews, for
// managing replies. Same review data shape as the public endpoint in
// routes/directory.js — reviewer identity still isn't exposed, even to the
// business being reviewed; sign-in-to-review guards against spam, not
// anonymity.
router.get('/reviews', async (req, res) => {
  try {
    const { data: business } = await supabaseAdmin
      .from('businesses')
      .select('id')
      .eq('id', req.user.id)
      .maybeSingle();
    if (!business) return res.json({ reviews: [] });

    const { data, error } = await supabaseAdmin
      .from('business_reviews')
      .select('id, rating, comment, reply, replied_at, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    res.json({ reviews: data || [] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load your reviews' });
  }
});

// PUT /api/business/reviews/:reviewId/reply — reply to a review on the
// caller's OWN business. Ownership is checked by comparing the review's
// business_id against req.user.id (a business row's id IS its owner's auth
// user id in this schema — see schema.sql), not just trusting the reviewId
// in the URL — otherwise any signed-in business owner could reply to any
// OTHER business's reviews just by guessing/enumerating review ids.
router.put('/reviews/:reviewId/reply', async (req, res) => {
  const { reply } = req.body || {};
  if (!reply || !reply.trim()) {
    return res.status(400).json({ error: 'Enter a reply' });
  }
  try {
    const { data: review } = await supabaseAdmin
      .from('business_reviews')
      .select('id, business_id')
      .eq('id', req.params.reviewId)
      .maybeSingle();
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.business_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only reply to reviews on your own listing' });
    }

    const { data, error } = await supabaseAdmin
      .from('business_reviews')
      .update({ reply: reply.trim(), replied_at: new Date().toISOString() })
      .eq('id', req.params.reviewId)
      .select('id, rating, comment, reply, replied_at, created_at')
      .single();
    if (error) throw new Error(error.message);

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save your reply' });
  }
});

// DELETE /api/business/reviews/:reviewId/reply — remove your reply. The
// review itself stays — removing the whole review is the reviewer's call
// (see routes/reviews.js), not the business's.
router.delete('/reviews/:reviewId/reply', async (req, res) => {
  try {
    const { data: review } = await supabaseAdmin
      .from('business_reviews')
      .select('id, business_id')
      .eq('id', req.params.reviewId)
      .maybeSingle();
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.business_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only manage replies on your own listing' });
    }

    const { error } = await supabaseAdmin
      .from('business_reviews')
      .update({ reply: null, replied_at: null })
      .eq('id', req.params.reviewId);
    if (error) throw new Error(error.message);

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove your reply' });
  }
});

// ── Business vacancies — a business can have SEVERAL open roles at once
// (unlike the single optional voucher earlier in this file), so these live
// in their own table (business_vacancies, one row per vacancy) rather than
// columns on the businesses row. Same "manage your own, ownership checked
// against req.user.id" shape as the review-reply endpoints above. Reading
// vacancies publicly — the "Local Jobs" page and the "N roles open" badge
// on a directory row — lives in routes/directory.js, same public/private
// split as reviews.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateVacancyInput(body) {
  const title = ((body && body.title) || '').trim();
  const description = ((body && body.description) || '').trim() || null;
  const applyEmail = ((body && body.applyEmail) || '').trim() || null;
  const applyUrl = normalizeWebsiteUrl(body && body.applyUrl);
  const expiresAt = ((body && body.expiresAt) || '').trim() || null;

  if (!title) throw new Error('A job title is required');
  if (!applyEmail && !applyUrl) throw new Error('Add an email address or a web link for people to apply');
  if (applyEmail && !EMAIL_RE.test(applyEmail)) throw new Error("That doesn't look like a valid email address");
  if (expiresAt) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('Closing date must be a valid date');
    }
    if (expiresAt < todayKey) throw new Error('Closing date must be in the future');
  }
  return { title, description, applyEmail, applyUrl, expiresAt };
}

// GET /api/business/vacancies — the caller's OWN vacancies, for managing
// them (including ones already past their closing date, so an owner can
// still see/reopen one rather than it just vanishing from view).
router.get('/vacancies', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('business_vacancies')
      .select('id, title, description, apply_email, apply_url, expires_at, created_at')
      .eq('business_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ vacancies: data || [] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load your vacancies' });
  }
});

// POST /api/business/vacancies — add a new vacancy. Requires a listing to
// already exist, same "create the listing, then enhance it" order as the
// logo upload and Featured upgrade above.
router.post('/vacancies', async (req, res) => {
  try {
    const { data: business } = await supabaseAdmin
      .from('businesses')
      .select('id')
      .eq('id', req.user.id)
      .maybeSingle();
    if (!business) {
      return res.status(400).json({ error: 'Create your business listing first, then add a vacancy' });
    }

    const clean = validateVacancyInput(req.body);
    const { data, error } = await supabaseAdmin
      .from('business_vacancies')
      .insert({
        business_id: req.user.id,
        title: clean.title,
        description: clean.description,
        apply_email: clean.applyEmail,
        apply_url: clean.applyUrl,
        expires_at: clean.expiresAt,
      })
      .select('id, title, description, apply_email, apply_url, expires_at, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save that vacancy' });
  }
});

// PUT /api/business/vacancies/:id — edit a vacancy on the caller's OWN
// listing. Ownership checked by comparing the vacancy's business_id against
// req.user.id, not just trusting the id in the URL — same reasoning as the
// review-reply endpoints (a business row's id IS its owner's auth user id).
router.put('/vacancies/:id', async (req, res) => {
  try {
    const { data: vacancy } = await supabaseAdmin
      .from('business_vacancies')
      .select('id, business_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!vacancy) return res.status(404).json({ error: 'Vacancy not found' });
    if (vacancy.business_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit vacancies on your own listing' });
    }

    const clean = validateVacancyInput(req.body);
    const { data, error } = await supabaseAdmin
      .from('business_vacancies')
      .update({
        title: clean.title,
        description: clean.description,
        apply_email: clean.applyEmail,
        apply_url: clean.applyUrl,
        expires_at: clean.expiresAt,
      })
      .eq('id', req.params.id)
      .select('id, title, description, apply_email, apply_url, expires_at, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not update that vacancy' });
  }
});

// DELETE /api/business/vacancies/:id — remove a vacancy from the caller's
// OWN listing.
router.delete('/vacancies/:id', async (req, res) => {
  try {
    const { data: vacancy } = await supabaseAdmin
      .from('business_vacancies')
      .select('id, business_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!vacancy) return res.status(404).json({ error: 'Vacancy not found' });
    if (vacancy.business_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only remove vacancies on your own listing' });
    }

    const { error } = await supabaseAdmin.from('business_vacancies').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove that vacancy' });
  }
});

module.exports = router;
