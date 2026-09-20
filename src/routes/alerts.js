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
// digest-only. One row per (consumer, location, alert_type) for three of
// the four types — traffic_route is keyed on (location, destination)
// together instead, since it needs a second saved location, see the POST
// handler below. The UI only offers combinations that don't already exist
// (see index.html), and this is enforced here too so a crafted request
// can't create a duplicate either.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');

const ALERT_TYPES = ['morning_digest', 'traffic_route', 'weather_warning', 'wildlife_nearby'];

router.use(requireAuth);

// GET /api/alerts — every alert preference the caller has, across all four
// types, with the location's label attached (so the frontend doesn't need
// a second lookup against /api/account/me's locations list just to show a
// name next to each row). traffic_route rows also get destinationLabel —
// their destination is a second saved location, stored as
// config.destinationLocationId rather than a second FK column (see the
// POST handler below), so it's resolved here with a small extra lookup.
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('alert_preferences')
      .select('id, location_id, alert_type, config, active, created_at, saved_locations(label)')
      .eq('consumer_id', req.user.id)
      .in('alert_type', ALERT_TYPES)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    const rows = data || [];
    const destinationIds = [...new Set(
      rows.filter((p) => p.alert_type === 'traffic_route' && p.config && p.config.destinationLocationId)
        .map((p) => p.config.destinationLocationId)
    )];
    let destinationLabels = {};
    if (destinationIds.length) {
      const { data: destinations } = await supabaseAdmin
        .from('saved_locations')
        .select('id, label')
        .in('id', destinationIds);
      destinationLabels = Object.fromEntries((destinations || []).map((d) => [d.id, d.label]));
    }

    const preferences = rows.map((p) => ({
      id: p.id,
      locationId: p.location_id,
      locationLabel: p.saved_locations ? p.saved_locations.label : 'Unknown location',
      alertType: p.alert_type,
      config: p.config || {},
      active: p.active,
      destinationLabel: p.config && p.config.destinationLocationId
        ? (destinationLabels[p.config.destinationLocationId] || 'Unknown location')
        : null,
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
  // traffic_route needs a SECOND saved location (its destination) — stored
  // as config.destinationLocationId rather than a second FK column on
  // alert_preferences, so no schema change was needed to add this. Ownership
  // and "different from the origin" are both checked below, same as the
  // origin location itself.
  let destinationLocationId = null;
  if (alertType === 'traffic_route') {
    destinationLocationId = config && config.destinationLocationId;
    if (!destinationLocationId) {
      return res.status(400).json({ error: 'A destination saved location is required for a traffic-route alert' });
    }
    if (destinationLocationId === locationId) {
      return res.status(400).json({ error: 'Origin and destination must be different saved locations' });
    }
    const delayThresholdMinutes = config && config.delayThresholdMinutes != null ? Number(config.delayThresholdMinutes) : 10;
    if (!Number.isInteger(delayThresholdMinutes) || delayThresholdMinutes < 1 || delayThresholdMinutes > 120) {
      return res.status(400).json({ error: 'Delay threshold must be a whole number of minutes between 1 and 120' });
    }
    cleanConfig = { destinationLocationId, delayThresholdMinutes };
  }
  // weather_warning/wildlife_nearby take no required config yet (sensible
  // defaults are applied in jobs/alertEngine.js) — left as {} rather than
  // accepting arbitrary client-supplied config fields.

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

    const locationIdsToCheck = destinationLocationId ? [locationId, destinationLocationId] : [locationId];
    const { data: ownedLocations, error: locErr } = await supabaseAdmin
      .from('saved_locations')
      .select('id')
      .in('id', locationIdsToCheck)
      .eq('consumer_id', req.user.id);
    if (locErr) throw new Error(locErr.message);
    if ((ownedLocations || []).length !== locationIdsToCheck.length) {
      return res.status(404).json({ error: 'One of those saved locations was not found' });
    }

    // Duplicate check: for traffic_route this is keyed on (location,
    // destination) together, not just location — home→work and home→gym
    // are both valid, distinct alerts from the same origin. The other
    // three types stay one-per-(location, type), checked with a plain
    // query; traffic_route's destination lives inside the jsonb config, so
    // it's compared in JS after fetching this consumer's existing
    // traffic_route rows for that origin, rather than a jsonb query.
    const { data: existingForLocation, error: existErr } = await supabaseAdmin
      .from('alert_preferences')
      .select('id, config')
      .eq('consumer_id', req.user.id)
      .eq('location_id', locationId)
      .eq('alert_type', alertType);
    if (existErr) throw new Error(existErr.message);
    const duplicate = alertType === 'traffic_route'
      ? (existingForLocation || []).some((p) => p.config && p.config.destinationLocationId === destinationLocationId)
      : (existingForLocation || []).length > 0;
    if (duplicate) {
      // morning_digest and traffic_route have an editable field (send hour,
      // delay threshold), so it's genuinely true you can edit those instead
      // of removing them. weather_warning/wildlife_nearby have nothing to
      // edit yet, so don't tell the user "edit" is an option that isn't there.
      const canEdit = alertType === 'morning_digest' || alertType === 'traffic_route';
      return res.status(409).json({
        error: canEdit
          ? 'You already have this alert set up for that location — edit or remove it instead'
          : 'You already have this alert set up for that location — remove it if you want to change it',
      });
    }

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

// PUT /api/alerts/:id  { active, config } — toggle on/off, and/or edit the
// one editable field each alert type has: morning_digest's sendHour, or
// traffic_route's delayThresholdMinutes. Changing a traffic_route's actual
// origin/destination is still a remove-then-re-add — only the threshold is
// editable in place. weather_warning/wildlife_nearby have no editable
// config yet, so a config edit for those is rejected rather than silently
// accepted and ignored.
router.put('/:id', async (req, res) => {
  const { active, config } = req.body || {};
  if (active === undefined && config === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  try {
    const { data: existing } = await supabaseAdmin
      .from('alert_preferences')
      .select('id, alert_type, config')
      .eq('id', req.params.id)
      .eq('consumer_id', req.user.id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Alert preference not found' });

    const updates = {};
    if (active !== undefined) updates.active = !!active;

    if (config !== undefined) {
      if (existing.alert_type === 'morning_digest') {
        const hour = Number(config && config.sendHour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          return res.status(400).json({ error: 'A valid send hour (0-23) is required for the morning digest' });
        }
        updates.config = { sendHour: hour };
      } else if (existing.alert_type === 'traffic_route') {
        const delayThresholdMinutes = Number(config && config.delayThresholdMinutes);
        if (!Number.isInteger(delayThresholdMinutes) || delayThresholdMinutes < 1 || delayThresholdMinutes > 120) {
          return res.status(400).json({ error: 'Delay threshold must be a whole number of minutes between 1 and 120' });
        }
        // Origin/destination aren't editable here — only the threshold —
        // so keep the existing destinationLocationId as-is.
        updates.config = { ...(existing.config || {}), delayThresholdMinutes };
      } else {
        return res.status(400).json({ error: 'This alert type has nothing to edit — remove it and set it up again instead' });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('alert_preferences')
      .update(updates)
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
