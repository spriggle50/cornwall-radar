// Account routes — profile, saved locations, and the one alert type this
// MVP ships (morning digest). Everything here sits behind requireAuth, and
// every query is filtered on the logged-in user's own id — see the module
// comment in lib/supabaseClient.js for why that's done in JS here rather
// than left entirely to Postgres RLS.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');
const { geocodeLocation } = require('../fetchers/geocode');

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

    const { data: alerts, error: alertErr } = await supabaseAdmin
      .from('alert_preferences')
      .select('id, location_id, alert_type, config, active')
      .eq('consumer_id', req.user.id)
      .eq('alert_type', 'morning_digest');
    if (alertErr) throw new Error(alertErr.message);

    res.json({
      email: consumer.email,
      subscriptionStatus: consumer.subscription_status,
      isPaid: consumer.subscription_status === 'active',
      locations: locations || [],
      morningDigest: (alerts && alerts[0]) || null,
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

// PUT /api/account/morning-digest  { locationId, sendHour, active }
// The one alert type this MVP supports — see Cornwall-Radar-Spec.md §1 and
// §9 (Phase 1 ships "basic paid tier... one alert type" before the fuller
// alert engine in Phase 2). One row per consumer for now: saving always
// replaces whatever digest preference they already had, rather than
// managing a list — simpler UI, and still the full schema underneath if a
// second alert type gets added later.
//
// Paid-only, and enforced here, not just hidden in the UI — the UI is just
// JS anyone can bypass by calling this endpoint directly.
router.put('/morning-digest', async (req, res) => {
  const { locationId, sendHour, active } = req.body || {};
  const hour = Number(sendHour);
  if (!locationId || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return res.status(400).json({ error: 'A saved location and a valid hour (0-23) are required' });
  }

  try {
    const consumer = await ensureConsumer(req.user);
    if (consumer.subscription_status !== 'active') {
      return res.status(402).json({ error: 'The morning digest is a paid-tier feature — subscribe first' });
    }

    // Confirm the location actually belongs to this consumer before
    // linking it — otherwise a crafted request could point someone's
    // digest at a location id that isn't theirs.
    const { data: loc, error: locErr } = await supabaseAdmin
      .from('saved_locations')
      .select('id')
      .eq('id', locationId)
      .eq('consumer_id', req.user.id)
      .maybeSingle();
    if (locErr) throw new Error(locErr.message);
    if (!loc) return res.status(404).json({ error: 'That saved location was not found' });

    await supabaseAdmin
      .from('alert_preferences')
      .delete()
      .eq('consumer_id', req.user.id)
      .eq('alert_type', 'morning_digest');

    const { data, error } = await supabaseAdmin
      .from('alert_preferences')
      .insert({
        consumer_id: req.user.id,
        location_id: locationId,
        alert_type: 'morning_digest',
        config: { sendHour: hour },
        active: !!active,
      })
      .select('id, location_id, alert_type, config, active')
      .single();
    if (error) throw new Error(error.message);

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save your digest preference' });
  }
});

module.exports = router;
