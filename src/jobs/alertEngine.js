// The "fuller alert engine" from Cornwall-Radar-Spec.md §9 (Phase 2) — three
// real-time-ish alert types layered on top of the one-a-day morning digest
// (jobs/morningDigest.js): traffic_route, weather_warning, wildlife_nearby.
// Triggered from the exact same GET /api/cron/morning-digest endpoint the
// digest already uses (see server.js) — no second scheduler/pinger for Ady
// to set up, this just runs alongside it on every hit.
//
// Paid-tier only, same as the digest. All three share one shape: for every
// active alert_preferences row of that type, fetch the relevant data for
// that row's saved_location, decide whether anything alert-worthy is
// happening right now, and — if so, and it hasn't already been sent (see
// each type's own dedupe-key scheme below) — send one email and log it.
//
// IMPORTANT — these are Cornwall Radar's own threshold checks against
// public data (Open-Meteo forecasts, the EA flood feed, TomTom/National
// Highways traffic, GBIF sightings), not official Met Office severe-weather
// warnings or an emergency service. Email wording says so explicitly —
// never phrase these as an official warning.
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');
const { sendEmail, isConfigured: emailConfigured } = require('../lib/emailClient');
const { getRouteTraffic } = require('../fetchers/routing');
const { getWeather } = require('../fetchers/weather');
const { getFloodAndRiverLevels } = require('../fetchers/floodMonitoring');
const { getRecentSightings } = require('../fetchers/wildlife');
const { distanceKm } = require('../lib/geo');

function londonDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date); // YYYY-MM-DD
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

const appUrl = process.env.APP_BASE_URL || 'https://cornwallradar.co.uk';

function wrapEmailHtml(heading, bodyLines) {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #12181a;">
      <h2 style="color:#076b4a; margin-bottom: 10px;">${heading}</h2>
      ${bodyLines.map((line) => `<p style="margin: 6px 0;">${line}</p>`).join('')}
      <p style="margin-top:24px; font-size:0.85em; color:#5b6b6a;">
        <a href="${appUrl}" style="color:#0a8f63;">Open Cornwall Radar</a> for the full live picture.
      </p>
    </div>
  `;
}

// ── Traffic-route alerts ────────────────────────────────────────────────
// A genuine A-to-B check now (fetchers/routing.js — TomTom Routing API with
// traffic=true), not the radius-based "incidents near one point" this used
// to do (that approximation is still what fetchers/traffic.js and the
// dashboard/digest use — this is the only place in the project that calls
// the Routing API instead). Alert-worthy = the route's current
// trafficDelaySeconds (how much longer it's taking than free-flow right
// now) is at or above the consumer's chosen threshold.
//
// origin/destination are both required — a preference created before this
// upgrade (radius-only, no destination saved) has nothing to route between,
// so it's skipped rather than guessing a destination; see
// routes/alerts.js, which now requires a destination for every new
// traffic_route preference.
async function checkTrafficRoute(origin, destination, config, dateKey) {
  if (!destination) return null;

  const thresholdMinutes = (config && config.delayThresholdMinutes) || 10;
  const route = await getRouteTraffic(origin, destination);
  if (!route.configured) return null;

  const delayMinutes = Math.round(route.trafficDelaySeconds / 60);
  if (delayMinutes < thresholdMinutes) return null;

  // Bucketed into 5-minute bands (per calendar day) rather than the exact
  // minute count — a delay hovering around 14-16 minutes across successive
  // hourly checks would otherwise dedupe-bust and re-alert every single
  // run purely from noise. A genuinely worsening delay (crossing into the
  // next band) still alerts again the same day; a small fluctuation within
  // the same band doesn't.
  const band = Math.floor(delayMinutes / 5) * 5;
  const dedupeKey = `traffic_route:${dateKey}:${origin.id}:${destination.id}:${band}`;

  const travelMinutes = Math.round(route.travelTimeSeconds / 60);
  return {
    dedupeKey,
    subject: `Traffic alert — ${origin.label} to ${destination.label}`,
    html: wrapEmailHtml(`🚗 ${origin.label} → ${destination.label}`, [
      `Currently taking about ${travelMinutes} min — that's roughly ${delayMinutes} min longer than normal due to traffic.`,
    ]),
  };
}

// ── Weather-warning alerts ──────────────────────────────────────────────
// Rule-based thresholds against Open-Meteo + the EA flood feed — see the
// file header. Each condition type dedupes separately, once per calendar
// day, so a spell of bad weather doesn't re-alert on every hourly cron hit
// but genuinely new conditions (or the same conditions returning tomorrow)
// do go out again.
const HEAVY_RAIN_CODES = [65, 82, 95, 96, 99];

async function checkWeatherWarning(location, config, dateKey) {
  const [weather, flood] = await Promise.all([
    getWeather(location.lat, location.lng).catch((e) => ({ unavailable: true, error: e.message })),
    getFloodAndRiverLevels({ lat: location.lat, lon: location.lng }).catch((e) => ({ unavailable: true, error: e.message })),
  ]);

  const current = !weather.unavailable ? weather.current : null;
  const today = !weather.unavailable ? (weather.forecast || [])[0] : null;
  const conditions = [];

  if (current && current.windGustsKph != null && current.windGustsKph >= 50) {
    conditions.push({ type: 'high_wind', message: `Wind gusts of around ${Math.round(current.windGustsKph)}km/h reported right now` });
  }
  if (today) {
    if (today.rainChancePct >= 80 && HEAVY_RAIN_CODES.includes(today.code)) {
      conditions.push({ type: 'heavy_rain', message: `${today.rainChancePct}% chance of heavy rain today` });
    }
    if (today.maxTempC != null && today.maxTempC >= 30) {
      conditions.push({ type: 'extreme_heat', message: `Very hot today — up to ${Math.round(today.maxTempC)}°C` });
    }
    if (today.minTempC != null && today.minTempC <= 0) {
      conditions.push({ type: 'frost_ice', message: `Risk of frost/ice — down to ${Math.round(today.minTempC)}°C overnight` });
    }
  }
  const activeFloodWarnings = !flood.unavailable && Array.isArray(flood.warnings)
    ? flood.warnings.filter((w) => w.severityLevel == null || w.severityLevel < 4)
    : [];
  if (activeFloodWarnings.length) {
    conditions.push({
      type: 'flood',
      message: `${activeFloodWarnings.length} flood/river warning${activeFloodWarnings.length === 1 ? '' : 's'} active in Cornwall — most severe: ${activeFloodWarnings[0].severity}`,
    });
  }

  if (!conditions.length) return null;

  // One email per run bundling whichever condition TYPES are new today —
  // each type has its own dedupe key, so e.g. "high wind" already sent
  // today doesn't block a freshly-detected "flood" condition from also
  // going out in its own right (checked/logged individually below, in the
  // caller), but for the email body itself we just show everything
  // currently true, new or not, for full context.
  return {
    // Caller treats this specially: one dedupe key PER condition type, not
    // one for the whole bundle — see runAlertEngine's handling of
    // `perConditionDedupe`.
    perConditionDedupe: conditions.map((c) => `weather_warning:${dateKey}:${location.id}:${c.type}`),
    subject: `Weather alert for ${location.label}`,
    html: wrapEmailHtml(`⛈️ Weather alert — ${location.label}`, [
      'Cornwall Radar\'s own threshold check flagged the following (not an official Met Office warning):',
      ...conditions.map((c) => `• ${c.message}`),
    ]),
  };
}

// ── Wildlife-nearby alerts ──────────────────────────────────────────────
// GBIF sightings aren't filtered by rarity/notability (no such data source
// is wired up anywhere in this project) — this is "a sighting of this
// species was logged near your spot recently", full stop, not "something
// unusual". To keep that honest limitation from making the alert a firehose
// of routine gull/pigeon records, it dedupes per SPECIES per location per
// rolling 14-day window (not per individual sighting) — so a location only
// gets alerted about, say, "Herring Gull" once every ~2 weeks even if GBIF
// logs fifty of them in that time, while a species that hasn't shown up
// near that spot in a while still comes through as new.
const WILDLIFE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

async function checkWildlifeNearby(location, config, dateKey) {
  const radiusKm = (config && config.radiusKm) || 10;
  const result = await getRecentSightings({ limit: 50 });
  const windowIndex = Math.floor(Date.now() / WILDLIFE_WINDOW_MS);

  const nearby = (result.sightings || []).filter((s) => {
    if (s.lat == null || s.lon == null) return false;
    return distanceKm(location.lat, location.lng, s.lat, s.lon) <= radiusKm;
  });
  if (!nearby.length) return null;

  // One row per distinct species within range, newest first.
  const bySpecies = new Map();
  for (const s of nearby) {
    if (!bySpecies.has(s.species)) bySpecies.set(s.species, s);
  }

  return {
    perConditionDedupe: [...bySpecies.keys()].map((species) => `wildlife_nearby:${location.id}:${slugify(species)}:${windowIndex}`),
    subject: `Wildlife nearby — ${location.label}`,
    html: wrapEmailHtml(`🦊 Wildlife sighted near ${location.label}`, [
      `Recent sightings (GBIF) within ${radiusKm}km — not filtered by rarity, just what's been logged nearby:`,
      ...[...bySpecies.values()].slice(0, 10).map((s) => `• ${s.species}${s.locality ? ' — ' + s.locality : ''}`),
    ]),
  };
}

const CHECKERS = {
  traffic_route: checkTrafficRoute,
  weather_warning: checkWeatherWarning,
  wildlife_nearby: checkWildlifeNearby,
};

async function runAlertEngine() {
  if (!supabaseConfigured()) return { sent: 0, skipped: 'supabase not configured' };
  if (!emailConfigured()) return { sent: 0, skipped: 'email not configured' };

  const dateKey = londonDateKey();

  const { data: prefs, error } = await supabaseAdmin
    .from('alert_preferences')
    .select('id, consumer_id, location_id, alert_type, config, active, consumers(email, subscription_status), saved_locations(id, label, lat, lng)')
    .in('alert_type', Object.keys(CHECKERS))
    .eq('active', true);

  if (error) {
    console.error('[alertEngine] failed to load preferences:', error.message);
    return { sent: 0, error: error.message };
  }

  // traffic_route is the one type needing a SECOND location (its
  // destination, stored as config.destinationLocationId rather than a
  // second FK column — see routes/alerts.js). Resolved here in one batch
  // query rather than per-row, then looked up by id in the loop below.
  const destinationIds = [...new Set(
    (prefs || [])
      .filter((p) => p.alert_type === 'traffic_route' && p.config && p.config.destinationLocationId)
      .map((p) => p.config.destinationLocationId)
  )];
  let destinationsById = {};
  if (destinationIds.length) {
    const { data: destinations } = await supabaseAdmin
      .from('saved_locations')
      .select('id, label, lat, lng')
      .in('id', destinationIds);
    destinationsById = Object.fromEntries((destinations || []).map((d) => [d.id, d]));
  }

  let sent = 0;
  let checked = 0;
  const errors = [];

  for (const pref of prefs || []) {
    const consumer = pref.consumers;
    const location = pref.saved_locations;
    const checker = CHECKERS[pref.alert_type];
    if (!checker || !consumer || consumer.subscription_status !== 'active' || !location) continue;

    checked += 1;
    try {
      const result = pref.alert_type === 'traffic_route'
        ? await checkTrafficRoute(
            location,
            pref.config && pref.config.destinationLocationId ? destinationsById[pref.config.destinationLocationId] : null,
            pref.config || {},
            dateKey,
          )
        : await checker(location, pref.config || {}, dateKey);
      if (!result) continue;

      // Two shapes: a single dedupeKey (traffic), or perConditionDedupe (an
      // array — weather/wildlife bundle several conditions/species into one
      // email but track each one's "already sent" state separately).
      const keys = result.perConditionDedupe || [result.dedupeKey];
      const { data: already } = await supabaseAdmin
        .from('alert_log')
        .select('dedupe_key')
        .eq('consumer_id', pref.consumer_id)
        .in('dedupe_key', keys);
      const alreadySent = new Set((already || []).map((r) => r.dedupe_key));
      const newKeys = keys.filter((k) => !alreadySent.has(k));
      if (!newKeys.length) continue; // everything in this bundle already went out

      await sendEmail({ to: consumer.email, subject: result.subject, html: result.html });

      await supabaseAdmin.from('alert_log').insert(
        newKeys.map((dedupeKey) => ({ consumer_id: pref.consumer_id, alert_type: pref.alert_type, dedupe_key: dedupeKey }))
      );

      sent += 1;
    } catch (err) {
      console.error(`[alertEngine] ${pref.alert_type} failed for consumer ${pref.consumer_id}:`, err.message);
      errors.push({ consumerId: pref.consumer_id, alertType: pref.alert_type, error: err.message });
    }
  }

  return { sent, checked, errors };
}

module.exports = { runAlertEngine };
