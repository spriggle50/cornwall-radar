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
      .select('id, name, category, description, phone, website, postcode, lat, lng, logo_url, subscription_status')
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
  const { name, category, description, phone, website, postcode } = req.body || {};
  if (!name || !name.trim() || !category || !category.trim() || !postcode || !postcode.trim()) {
    return res.status(400).json({ error: 'A business name, category and postcode/town are all required' });
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
        website: (website || '').trim() || null,
        postcode: postcode.trim(),
        lat: geo.lat,
        lng: geo.lon,
        logo_url: existing ? existing.logo_url : null,
        stripe_customer_id: existing ? existing.stripe_customer_id : null,
        subscription_status: existing ? existing.subscription_status : 'free',
      })
      .select('id, name, category, description, phone, website, postcode, lat, lng, logo_url, subscription_status')
      .single();
    if (error) throw new Error(error.message);

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

module.exports = router;
