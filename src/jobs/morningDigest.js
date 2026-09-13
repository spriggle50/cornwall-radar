// The Phase 1 "one alert type" (see Cornwall-Radar-Spec.md §1 and §9): a
// daily email summarising a subscriber's saved location, sent at the hour
// they picked. Meant to be triggered by an external scheduler — a Railway
// Cron Job, or a free pinger like cron-job.org — hitting
// GET /api/cron/morning-digest roughly once an hour. See server.js for the
// route and the project setup notes for how to wire the scheduler up.
//
// Dedupe: alert_log.dedupe_key stops the same person getting two digests if
// the scheduler fires twice within the same hour, or is a few minutes
// early/late across a restart. One row per consumer per calendar day
// (Europe/London) — see londonDateKey below.
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');
const { sendEmail, isConfigured: emailConfigured } = require('../lib/emailClient');
const { getWeather } = require('../fetchers/weather');
const { getTideTimes } = require('../fetchers/tides');
const { getTrafficIncidents } = require('../fetchers/traffic');

// Europe/London hour as an integer 0-23, DST-aware — matches the timezone
// every other fetcher in this project already uses (see weather.js's
// `timezone: 'Europe/London'` forecast param).
function currentLondonHour(date = new Date()) {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', hour12: false,
  }).format(date);
  return parseInt(formatted, 10) % 24;
}

function londonDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date); // YYYY-MM-DD
}

function digestHtml({ location, weather, tides, traffic }) {
  const w = weather && !weather.unavailable ? weather.current : null;
  const forecastToday = weather && !weather.unavailable ? (weather.forecast || [])[0] : null;
  const weatherLine = w
    ? `${w.emoji} ${Math.round(w.tempC)}&deg;C, ${w.condition.toLowerCase()} (feels like ${Math.round(w.feelsLikeC)}&deg;C)`
    : 'Weather unavailable right now';
  const rainLine = forecastToday ? `${forecastToday.rainChancePct}% chance of rain today` : '';

  const firstTide = tides && !tides.unavailable && Array.isArray(tides.tides) ? tides.tides[0] : null;
  const tideLine = firstTide
    ? `${firstTide.type} tide today at ${firstTide.time} (${firstTide.heightM}m) — ${tides.station}`
    : '';

  const incidentCount = traffic && !traffic.unavailable && Array.isArray(traffic.incidents) ? traffic.incidents.length : null;
  const trafficLine = incidentCount == null
    ? ''
    : (incidentCount === 0
      ? 'No traffic incidents reported nearby'
      : `${incidentCount} traffic incident${incidentCount === 1 ? '' : 's'} reported nearby`);

  const appUrl = process.env.APP_BASE_URL || 'https://cornwallradar.co.uk';

  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #12181a;">
      <h2 style="color:#076b4a; margin-bottom: 4px;">Good morning — here's ${location.label}</h2>
      <p style="font-size:1.1em; margin: 12px 0 4px;">${weatherLine}</p>
      ${rainLine ? `<p style="margin: 2px 0;">${rainLine}</p>` : ''}
      ${tideLine ? `<p style="margin: 2px 0;">${tideLine}</p>` : ''}
      ${trafficLine ? `<p style="margin: 2px 0;">${trafficLine}</p>` : ''}
      <p style="margin-top:24px; font-size:0.85em; color:#5b6b6a;">
        <a href="${appUrl}" style="color:#0a8f63;">Open Cornwall Radar</a> for the full live picture.
      </p>
    </div>
  `;
}

async function runMorningDigest() {
  if (!supabaseConfigured()) return { sent: 0, skipped: 'supabase not configured' };
  if (!emailConfigured()) return { sent: 0, skipped: 'email not configured' };

  const hour = currentLondonHour();
  const dateKey = londonDateKey();

  const { data: prefs, error } = await supabaseAdmin
    .from('alert_preferences')
    .select('id, consumer_id, location_id, config, active, consumers(email, subscription_status), saved_locations(label, lat, lng)')
    .eq('alert_type', 'morning_digest')
    .eq('active', true);

  if (error) {
    console.error('[morningDigest] failed to load preferences:', error.message);
    return { sent: 0, error: error.message };
  }

  let sent = 0;
  const errors = [];

  for (const pref of prefs || []) {
    try {
      const sendHour = pref.config && typeof pref.config.sendHour === 'number' ? pref.config.sendHour : null;
      if (sendHour !== hour) continue;

      const consumer = pref.consumers;
      const location = pref.saved_locations;
      if (!consumer || consumer.subscription_status !== 'active' || !location) continue;

      const dedupeKey = `morning_digest:${dateKey}:${pref.consumer_id}`;
      const { data: already } = await supabaseAdmin
        .from('alert_log')
        .select('id')
        .eq('consumer_id', pref.consumer_id)
        .eq('dedupe_key', dedupeKey)
        .maybeSingle();
      if (already) continue;

      const [weather, tides, traffic] = await Promise.all([
        getWeather(location.lat, location.lng).catch((e) => ({ unavailable: true, error: e.message })),
        getTideTimes({ lat: location.lat, lon: location.lng }).catch((e) => ({ unavailable: true, error: e.message })),
        getTrafficIncidents({ lat: location.lat, lon: location.lng }).catch((e) => ({ unavailable: true, error: e.message })),
      ]);

      await sendEmail({
        to: consumer.email,
        subject: `Your Cornwall Radar morning digest — ${location.label}`,
        html: digestHtml({ location, weather, tides, traffic }),
      });

      await supabaseAdmin.from('alert_log').insert({
        consumer_id: pref.consumer_id,
        alert_type: 'morning_digest',
        dedupe_key: dedupeKey,
      });

      sent += 1;
    } catch (err) {
      console.error(`[morningDigest] failed for consumer ${pref.consumer_id}:`, err.message);
      errors.push({ consumerId: pref.consumer_id, error: err.message });
    }
  }

  return { sent, checked: (prefs || []).length, errors };
}

module.exports = { runMorningDigest };
