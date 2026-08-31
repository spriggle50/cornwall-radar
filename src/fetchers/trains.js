// Live train departures — National Rail's Darwin/LDBWS real-time feed,
// reached via Huxley2 (a JSON proxy for LDBWS's native SOAP API, so this
// project never has to speak SOAP: https://github.com/davwheat/Huxley2).
//
// Two ways to run this:
//  1) Set RAILDATA_API_KEY — a free LDBWS access token from the Rail Data
//     Marketplace (https://raildata.org.uk, the current official successor
//     to the old realtime.nationalrail.co.uk registration page). When set,
//     requests go to Huxley2's own public demo instance with that token
//     attached, which is the properly-licensed way to do this.
//  2) Leave it unset — falls back to a free, keyless, community-hosted
//     Huxley2 instance (national-rail-api.davwheat.dev) that already has a
//     token configured server-side. Convenient for getting started, but
//     it's a volunteer-run service with (its own words) "zero guarantees
//     of uptime", so RAILDATA_API_KEY is the more reliable long-term option.
const { nearestStation } = require('../lib/cornwallStations');

const RAILDATA_API_KEY = process.env.RAILDATA_API_KEY;
const HUXLEY_BASE_WITH_KEY = 'https://huxley2.azurewebsites.net';
const HUXLEY_BASE_KEYLESS = 'https://national-rail-api.davwheat.dev';

const DEFAULT_LAT = 50.2632; // Truro, Cornwall — same default as the rest of the app
const DEFAULT_LON = -5.0510;

async function getTrainDepartures({ lat = DEFAULT_LAT, lon = DEFAULT_LON } = {}) {
  const station = nearestStation(lat, lon);
  if (!station) {
    return { source: 'National Rail', configured: true, station: null, services: [], message: 'Could not resolve a nearby station' };
  }

  const base = RAILDATA_API_KEY ? HUXLEY_BASE_WITH_KEY : HUXLEY_BASE_KEYLESS;
  const url = new URL('/departures/' + station.crs, base);
  url.searchParams.set('expand', 'false');
  if (RAILDATA_API_KEY) url.searchParams.set('accessToken', RAILDATA_API_KEY);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  });
  if (!res.ok) {
    throw new Error(`Train departures request failed (${station.name}): ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const services = (data.trainServices || []).map((s) => ({
    scheduledTime: s.std || null,
    // Huxley2/Darwin puts either an updated time ("17:56") or a status
    // word ("On time", "Cancelled", "Delayed") in etd depending on what's
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
    source: RAILDATA_API_KEY ? 'National Rail (Huxley2)' : 'National Rail (Huxley2 community relay)',
    configured: true,
    station: { name: data.locationName || station.name, crs: data.crs || station.crs, distanceKm: station.distanceKm },
    services,
    disruptionMessages: (data.nrccMessages || []).map((m) => (typeof m === 'string' ? m : m.value || m.Value || '')).filter(Boolean),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getTrainDepartures };
