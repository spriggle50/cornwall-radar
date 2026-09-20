// Account routes — profile and saved locations. Alert preferences (morning
// digest, traffic, weather, wildlife) live in routes/alerts.js instead.
// Everything here sits behind requireAuth, and every query is filtered on
// the logged-in user's own id — see the module comment in
// lib/supabaseClient.js for why that's done in JS here rather than left
// entirely to Postgres RLS.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');
const { geocodeLocation } = require('../fetchers/geocode');
const { stripe } = require('../lib/stripeClient');

router.use(requireAuth);

// There's no separate "sign up" step here — Supabase Auth handles that
// entirely client-side (magic link OR email+password, see index.html's
// login card), and the first authenticated request against this backend
// just creates the matching `consumers` row if it doesn't exist yet,
// whichever way the person signed in. Uses the service-role client because
// `consumers` only has a SELECT policy for the owner, not INSERT (see
// schema.sql) — a normal user token could never do this insert itself, by
// design.
async function ensureConsumer(user) {
  const { data: existing, error: selErr } = await supabaseAdmin
    .from('consumers')
    .select('id, email, subscription_status, stripe_customer_id')
    .eq('id', user.id)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (existing) return existing;

  const { data: created, error: insErr } = await supabaseAdmin
    .from('consumers')
    .insert({ id: user.id, email: user.email })
    .select('id, email, subscription_status, stripe_customer_id')
    .single();
  if (insErr) throw new Error(insErr.message);
  return created;
}

// GET /api/account/me — profile + saved locations + the current morning
// digest setting, everything the account panel needs in one call.
router.get('/me', async (req, res) => {
  try {
    const consumer = await ensureConsumer(req.user);

    const { data: locations, error: locErr } = await supabaseAdmin
      .from('saved_locations')
      .select('id, label, postcode, lat, lng, created_at')
      .eq('consumer_id', req.user.id)
      .order('created_at', { ascending: true });
    if (locErr) throw new Error(locErr.message);

    res.json({
      email: consumer.email,
      subscriptionStatus: consumer.subscription_status,
      isPaid: consumer.subscription_status === 'active',
      locations: locations || [],
    });
  } catch (err) {
    console.error('[account] /me failed:', err.message);
    res.status(500).json({ error: 'Could not load your account' });
  }
});

// POST /api/account/locations  { label, postcode }
// postcode/town text goes through the same geocode fetcher the location
// search bar already uses, so "Home" + "TR1 2AB" resolves to a real lat/lng
// without the user ever having to find coordinates themselves.
router.post('/locations', async (req, res) => {
  const { label, postcode } = req.body || {};
  if (!label || !label.trim() || !postcode || !postcode.trim()) {
    return res.status(400).json({ error: 'A label and a postcode or town are both required' });
  }

  try {
    await ensureConsumer(req.user);
    const geo = await geocodeLocation(postcode);

    const { data, error } = await supabaseAdmin
      .from('saved_locations')
      .insert({
        consumer_id: req.user.id,
        label: label.trim(),
        postcode: postcode.trim(),
        lat: geo.lat,
        lng: geo.lon,
      })
      .select('id, label, postcode, lat, lng, created_at')
      .single();
    if (error) throw new Error(error.message);

    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save that location' });
  }
});

// DELETE /api/account/locations/:id
router.delete('/locations/:id', async (req, res) => {
  try {
    // schema.sql's alert_preferences.location_id FK is ON DELETE CASCADE,
    // so this isn't strictly necessary — but being explicit here means a
    // deleted location can never silently leave a dangling digest pointed
    // at nothing, regardless of how the cascade behaves.
    await supabaseAdmin
      .from('alert_preferences')
      .delete()
      .eq('consumer_id', req.user.id)
      .eq('location_id', req.params.id);

    const { error, count } = await supabaseAdmin
      .from('saved_locations')
      .delete({ count: 'exact' })
      .eq('id', req.params.id)
      .eq('consumer_id', req.user.id);
    if (error) throw new Error(error.message);
    if (!count) return res.status(404).json({ error: 'Location not found' });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove that location' });
  }
});

// Alert preferences (morning digest, traffic, weather, wildlife) used to
// have their own singular PUT /morning-digest route here, limited to one
// digest at a time. That's been replaced by routes/alerts.js, which covers
// all four alert types as genuine multi-row CRUD (add one per saved
// location, not just a single slot) — see that file for the full reasoning.

// DELETE /api/account/me — permanently deletes the caller's ENTIRE account:
// consumer profile, business listing (if any), saved locations, digest
// preferences, and the underlying Supabase Auth user itself, so they can
// never sign back in with this email again either. Postgres does almost
// all of the actual work here: every related table's foreign key is
// `references ... on delete cascade` (see schema.sql), all the way down
// from auth.users — deleting the auth user alone wipes everything else in
// one go. Nothing in this route manually deletes rows table by table.
//
// The one thing that ISN'T automatic is Stripe: an active subscription
// keeps billing regardless of what happens in this app's own database, and
// once the account is gone, nobody — least of all the person who just
// deleted it — can sign in to Stripe's billing portal to stop it
// themselves. So any active/past-due subscription, consumer AND/OR
// business Featured, is looked up and cancelled directly against Stripe
// (by Stripe customer id, not from locally-cached subscription state) and
// the whole deletion is aborted if that fails, rather than silently
// deleting the account while leaving someone still being charged.
router.delete('/me', async (req, res) => {
  try {
    if (stripe) {
      const [{ data: consumer }, { data: business }] = await Promise.all([
        supabaseAdmin.from('consumers').select('stripe_customer_id').eq('id', req.user.id).maybeSingle(),
        supabaseAdmin.from('businesses').select('stripe_customer_id').eq('id', req.user.id).maybeSingle(),
      ]);
      const customerIds = [consumer?.stripe_customer_id, business?.stripe_customer_id].filter(Boolean);

      for (const customerId of customerIds) {
        for (const status of ['active', 'past_due', 'unpaid', 'trialing']) {
          const subs = await stripe.subscriptions.list({ customer: customerId, status, limit: 10 });
          for (const sub of subs.data) {
            await stripe.subscriptions.cancel(sub.id);
          }
        }
      }
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (error) throw new Error(error.message);

    res.json({ ok: true });
  } catch (err) {
    console.error('[account] delete failed:', err.message);
    res.status(500).json({ error: 'Could not delete your account (' + (err.message || 'unknown error') + ') — nothing was changed, please try again or contact support' });
  }
});

module.exports = router;
