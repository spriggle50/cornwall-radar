// Alert preferences — the paid-tier "which alerts, for which saved
// location" list, covering all four alert types the schema was designed
// for from the start (see schema.sql's alert_preferences.alert_type
// comment): morning_digest, traffic_route, weather_warning, wildlife_nearby.
// Actually sending anything lives in jobs/morningDigest.js and
// jobs/alertEngine.js — this file is only "manage your own preferences".
//
// This REPLACES the old singular PUT /api/account/morning-digest endpoint
// (account.js), which only ever let a consumer have exactly one digest at a
// time. Same table, same row shape underneath — just genuine multi-row
// CRUD now, and shared across all four alert types instead of being
// digest-only. One row per (consumer, location, alert_type): the UI only
// offers locations that don't already have a preference of that type (see
// index.html), and this is enforced here too so a crafted request can't
// create a duplicate either.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');

const ALERT_TYPES = ['morning_digest', 'traffic_route', 'weather_warning', 'wildlife_nearby'];

router.use(requireAuth);

// GET /api/alerts — every alert preference the caller has, across all four
// types, with the location's label attached (so the frontend doesn't need
// a second lookup against /api/account/me's locations list just to show a
// name next to each row).
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('alert_preferences')
      .select('id, location_id, alert_type, config, active, created_at, saved_locations(label)')
      .eq('consumer_id', req.user.id)
      .in('alert_type', ALERT_TYPES)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    const preferences = (data || []).map((p) => ({
      id: p.id,
      locationId: p.location_id,
      locationLabel: p.saved_locations ? p.saved_locations.label : 'Unknown location',
      alertType: p.alert_type,
      config: p.config || {},
      active: p.active,
    }));
    res.json({ preferences });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load your alert preferences' });
  }
});

// POST /api/alerts  { alertType, locationId, config }
// Paid-only, enforced here (not just hidden in the UI, which anyone could
// bypass by calling this endpoint directly) — same rule as the old digest
// endpoint this replaces.
router.post('/', async (req, res) => {
  const { alertType, locationId, config } = req.body || {};
  if (!ALERT_TYPES.includes(alertType)) {
    return res.status(400).json({ error: 'Unknown alert type' });
  }
  if (!locationId) {
    return res.status(400).json({ error: 'A saved location is required' });
  }

  let cleanConfig = {};
  if (alertType === 'morning_digest') {
    const hour = Number(config && config.sendHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return res.status(400).json({ error: 'A valid send hour (0-23) is required for the morning digest' });
    }
    cleanConfig = { sendHour: hour };
  }
  // traffic_route/weather_warning/wildlife_nearby take no required config
  // yet (sensible defaults are applied in jobs/alertEngine.js) — left as {}
  // rather than accepting arbitrary client-supplied config fields.

  try {
    const { data: consumer, error: consErr } = await supabaseAdmin
      .from('consumers')
      .select('subscription_status')
      .eq('id', req.user.id)
      .maybeSingle();
    if (consErr) throw new Error(consErr.message);
    if (!consumer || consumer.subscription_status !== 'active') {
      return res.status(402).json({ error: 'Alerts are a paid-tier feature — subscribe first' });
    }

    const { data: loc, error: locErr } = await supabaseAdmin
      .from('saved_locations')
      .select('id')
      .eq('id', locationId)
      .eq('consumer_id', req.user.id)
      .maybeSingle();
    if (locErr) throw new Error(locErr.message);
    if (!loc) return res.status(404).json({ error: 'That saved location was not found' });

    const { data: existing, error: existErr } = await supabaseAdmin
      .from('alert_preferences')
      .select('id')
      .eq('consumer_id', req.user.id)
      .eq('location_id', locationId)
      .eq('alert_type', alertType)
      .maybeSingle();
    if (existErr) throw new Error(existErr.message);
    if (existing) return res.status(409).json({ error: 'You already have this alert set up for that location — edit or remove it instead' });

    const { data, error } = await supabaseAdmin
      .from('alert_preferences')
      .insert({
        consumer_id: req.user.id,
        location_id: locationId,
        alert_type: alertType,
        config: cleanConfig,
        active: true,
      })
      .select('id, location_id, alert_type, config, active')
      .single();
    if (error) throw new Error(error.message);

    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save that alert' });
  }
});

// PUT /api/alerts/:id  { active } — toggle on/off. (Changing the digest
// hour or a radius is a remove-then-re-add in this first version, same as
// every other "edit" in this codebase's account panel being an upsert
// rather than a partial-field edit form.)
router.put('/:id', async (req, res) => {
  const { active } = req.body || {};
  try {
    const { data: existing } = await supabaseAdmin
      .from('alert_preferences')
      .select('id')
      .eq('id', req.params.id)
      .eq('consumer_id', req.user.id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Alert preference not found' });

    const { data, error } = await supabaseAdmin
      .from('alert_preferences')
      .update({ active: !!active })
      .eq('id', req.params.id)
      .select('id, location_id, alert_type, config, active')
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not update that alert' });
  }
});

// DELETE /api/alerts/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error, count } = await supabaseAdmin
      .from('alert_preferences')
      .delete({ count: 'exact' })
      .eq('id', req.params.id)
      .eq('consumer_id', req.user.id);
    if (error) throw new Error(error.message);
    if (!count) return res.status(404).json({ error: 'Alert preference not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove that alert' });
  }
});

module.exports = router;
