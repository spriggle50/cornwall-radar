// TomTom Routing API — genuine A-to-B travel time WITH live traffic, used
// only by the alert engine's traffic-route check (jobs/alertEngine.js).
// This is a different TomTom product from fetchers/traffic.js (Traffic
// Incidents, radius-based, used by the dashboard and morning digest) — same
// TOMTOM_API_KEY, no separate key/signup needed.
//
// Like every other fetcher in this project (see README's "Important" note),
// this is written correctly against TomTom's own documented response shape
// but has not been proven against a live response from this environment —
// its outbound network is blocked except to npm/GitHub. Test this against
// a real TomTom response before relying on it.
const { fetchWithTimeout } = require('../lib/fetchWithTimeout');

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;

const isConfigured = () => !!TOMTOM_API_KEY;

// origin/destination: { lat, lng }. traffic=true asks TomTom to route
// against live conditions and report how much of the travel time is
// currently attributable to traffic (trafficDelayInSeconds) — that delay,
// not the raw travel time, is the useful "is my commute bad right now"
// signal, since raw travel time is long for a long route regardless of
// traffic.
async function getRouteTraffic(origin, destination) {
  if (!isConfigured()) {
    return { configured: false, message: 'TOMTOM_API_KEY not set — add it to .env (developer.tomtom.com)' };
  }

  const locations = `${origin.lat},${origin.lng}:${destination.lat},${destination.lng}`;
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${locations}/json?key=${TOMTOM_API_KEY}&traffic=true&routeType=fastest`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TomTom routing request failed: ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  const route = (data.routes || [])[0];
  if (!route || !route.summary) {
    throw new Error('TomTom routing returned no usable route');
  }

  return {
    configured: true,
    travelTimeSeconds: route.summary.travelTimeInSeconds,
    trafficDelaySeconds: route.summary.trafficDelayInSeconds || 0,
    lengthMeters: route.summary.lengthInMeters,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getRouteTraffic, isConfigured };
