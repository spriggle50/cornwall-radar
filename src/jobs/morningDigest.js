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
const { getFloodAndRiverLevels } = require('../fetchers/floodMonitoring');

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

// The subject/greeting used to always say "Good morning" regardless of what
// hour the subscriber actually chose to be sent at (e.g. someone testing —
// or genuinely choosing — a 9pm send hour got "Good morning" at 9pm). This
// picks the right greeting for whatever hour the digest is actually going
// out at.
function greetingForHour(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function digestHtml({ location, weather, tides, traffic, flood, hour }) {
  const greeting = greetingForHour(hour);
  const w = weather && !weather.unavailable ? weather.current : null;
  const forecastToday = weather && !weather.unavailable ? (weather.forecast || [])[0] : null;
  const weatherLine = w
    ? `${w.emoji} ${Math.round(w.tempC)}&deg;C now, ${w.condition.toLowerCase()} (feels like ${Math.round(w.feelsLikeC)}&deg;C), wind ${Math.round(w.windKph)}km/h`
    : 'Weather unavailable right now';
  const forecastLine = forecastToday
    ? `Today's high ${Math.round(forecastToday.maxTempC)}&deg;C / low ${Math.round(forecastToday.minTempC)}&deg;C, ${forecastToday.rainChancePct}% chance of rain${forecastToday.uvIndexMax != null ? `, UV index ${Math.round(forecastToday.uvIndexMax)}` : ''}`
    : '';

  // Up to two tide events (the feed is already in chronological order
  // starting today) rather than just the very next one — enough to plan a
  // beach trip or harbour walk around, without dumping the whole day's feed.
  const upcomingTides = tides && !tides.unavailable && Array.isArray(tides.tides) ? tides.tides.slice(0, 2) : [];
  const tideLines = upcomingTides.map((t) => `${t.type} tide at ${t.time} (${t.heightM}m)`);
  const tideLine = tideLines.length ? `${tideLines.join(' · ')} — ${tides.station}` : '';

  const incidents = traffic && !traffic.unavailable && Array.isArray(traffic.incidents) ? traffic.incidents : null;
  const trafficHeadline = incidents == null
    ? ''
    : (incidents.length === 0
      ? 'No traffic incidents reported nearby'
      : `${incidents.length} traffic incident${incidents.length === 1 ? '' : 's'} reported nearby`);
  // Naming the actual road for the top couple of incidents is what makes
  // this useful before setting off, rather than just a bare count.
  const trafficDetail = incidents && incidents.length
    ? incidents.slice(0, 2).map((i) => `${i.road ? i.road + ': ' : ''}${i.description}`).join('; ')
    : '';

  // Flood/river warnings — Cornwall-wide (the EA feed isn't per-location),
  // but this is exactly the kind of "keeps people safe" content the product
  // is meant to lead with, so it's worth surfacing even though it's not
  // hyper-local to this one saved spot. Severity 4 ("no longer in force") is
  // filtered out here — it's a stand-down notice, not something worth a
  // paying subscriber's attention in a daily digest.
  const activeWarnings = flood && !flood.unavailable && Array.isArray(flood.warnings)
    ? flood.warnings.filter((wn) => wn.severityLevel == null || wn.severityLevel < 4)
    : null;
  const floodLine = activeWarnings == null
    ? ''
    : (activeWarnings.length === 0
      ? 'No flood or river warnings currently active in Cornwall'
      : `⚠️ ${activeWarnings.length} flood/river warning${activeWarnings.length === 1 ? '' : 's'} active in Cornwall — most severe: ${activeWarnings[0].severity}${activeWarnings[0].description ? ' (' + activeWarnings[0].description + ')' : ''}`);

  const appUrl = process.env.APP_BASE_URL || 'https://cornwallradar.co.uk';

  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #12181a;">
      <h2 style="color:#076b4a; margin-bottom: 4px;">${greeting} — here's ${location.label}</h2>
      <p style="font-size:1.1em; margin: 12px 0 4px;">${weatherLine}</p>
      ${forecastLine ? `<p style="margin: 2px 0;">${forecastLine}</p>` : ''}
      ${tideLine ? `<p style="margin: 10px 0 2px;">🌊 ${tideLine}</p>` : ''}
      ${trafficHeadline ? `<p style="margin: 10px 0 2px;">🚗 ${trafficHeadline}${trafficDetail ? ` — ${trafficDetail}` : ''}</p>` : ''}
      ${floodLine ? `<p style="margin: 10px 0 2px;">${floodLine}</p>` : ''}
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

      const [weather, tides, traffic, flood] = await Promise.all([
        getWeather(location.lat, location.lng).catch((e) => ({ unavailable: true, error: e.message })),
        getTideTimes({ lat: location.lat, lon: location.lng }).catch((e) => ({ unavailable: true, error: e.message })),
        getTrafficIncidents({ lat: location.lat, lon: location.lng }).catch((e) => ({ unavailable: true, error: e.message })),
        getFloodAndRiverLevels({ lat: location.lat, lon: location.lng }).catch((e) => ({ unavailable: true, error: e.message })),
      ]);

      await sendEmail({
        to: consumer.email,
        subject: `Your Cornwall Radar digest — ${location.label}`,
        html: digestHtml({ location, weather, tides, traffic, flood, hour }),
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
