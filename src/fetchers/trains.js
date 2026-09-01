// Live train departures — National Rail's Darwin/LDBWS real-time feed.
//
// Two ways to run this:
//  1) Set RAILDATA_API_KEY — a free subscription key from the Rail Data
//     Marketplace (https://raildata.org.uk). This is the CURRENT official
//     way to get LDBWS access, and it's a modern REST/JSON gateway, not the
//     old SOAP service — the key goes in an `x-apikey` header straight to
//     RDM's own GetDepartureBoard endpoint. (An earlier version of this
//     file wrongly assumed an RDM key was a classic NRE SOAP AccessToken
//     and tried to pass it as a query-string token to a third-party SOAP-
//     to-JSON proxy instead — that mismatch is what caused the 500s. This
//     is the corrected, actually-matching request shape, confirmed against
//     a real working integration's source rather than guessed.)
//  2) Leave it unset — falls back to a free, keyless, community-hosted
//     JSON relay (national-rail-api.davwheat.dev, a public instance of
//     https://github.com/davwheat/Huxley2 with its own token configured
//     server-side). Convenient for getting started, but it's a
//     volunteer-run service with (its own words) "zero guarantees of
//     uptime", so RAILDATA_API_KEY is the more reliable long-term option.
//     Both paths return the same underlying Darwin JSON shape, so parsing
//     below doesn't need to care which one served the request.
const { nearestStation } = require('../lib/cornwallStations');

const RAILDATA_API_KEY = process.env.RAILDATA_API_KEY;
const RAILDATA_BASE_URL = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepartureBoard';
const KEYLESS_RELAY_BASE_URL = 'https://national-rail-api.davwheat.dev/departures';

const DEFAULT_LAT = 50.2632; // Truro, Cornwall — same default as the rest of the app
const DEFAULT_LON = -5.0510;

async function getTrainDepartures({ lat = DEFAULT_LAT, lon = DEFAULT_LON } = {}) {
  const station = nearestStation(lat, lon);
  if (!station) {
    return { source: 'National Rail', configured: true, station: null, services: [], message: 'Could not resolve a nearby station' };
  }

  const headers = { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' };
  let url;
  if (RAILDATA_API_KEY) {
    url = new URL(RAILDATA_BASE_URL + '/' + station.crs);
    url.searchParams.set('numRows', '15');
    headers['x-apikey'] = RAILDATA_API_KEY;
  } else {
    url = new URL(KEYLESS_RELAY_BASE_URL + '/' + station.crs);
  }

  // Both this gateway and the fallback relay are third-party services this
  // app doesn't control, so a hard timeout stops one slow response from
  // hanging the whole dashboard refresh.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Train departures request failed (${station.name}): ${res.status} ${res.statusText}${rawText ? ' — ' + rawText.slice(0, 200) : ''}`);
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(`Train departures request failed (${station.name}): unexpected non-JSON response — ${rawText.slice(0, 200)}`);
  }

  const services = (data.trainServices || []).map((s) => ({
    scheduledTime: s.std || null,
    // Darwin puts either an updated time ("17:56") or a status word
    // ("On time", "Cancelled", "Delayed") in etd depending on what's
    // happened to the service — both are handled on the display side.
    expected: s.etd || null,
    platform: s.platform || null,
    operator: s.operator || null,
    isCancelled: !!s.isCancelled,
    delayReason: s.delayReason || null,
    cancelReason: s.cancelReason || null,
    origin: (s.origin && s.origin[0] && s.origin[0].locationName) || null,
    destination: (s.destination && s.destination[0] && s.destination[0].locationName) || null,
    serviceId: s.serviceID || null,
  }));

  return {
    source: RAILDATA_API_KEY ? 'National Rail (Rail Data Marketplace)' : 'National Rail (community relay)',
    configured: true,
    station: { name: data.locationName || station.name, crs: data.crs || station.crs, distanceKm: station.distanceKm },
    services,
    disruptionMessages: (data.nrccMessages || []).map((m) => (typeof m === 'string' ? m : m.value || m.Value || '')).filter(Boolean),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getTrainDepartures };
