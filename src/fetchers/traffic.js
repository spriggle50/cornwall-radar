// Traffic fetcher — National Highways + TomTom.
// NEEDS your own API key(s) — this cannot be tested until you supply one:
//   - TomTom Traffic API: free-tier key from https://developer.tomtom.com/
//   - National Highways: WebTRIS Traffic Data API is currently keyless for
//     some endpoints — https://webtris.nationalhighways.co.uk/api/swagger/ui/index
//     (worth checking current terms before relying on it — API policies change)
//
// This module is structured but deliberately not wired to live data yet.
// Set TOMTOM_API_KEY in your .env once you have one.

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;

async function getTrafficIncidents({ lat, lon, radiusMeters = 15000 } = {}) {
  if (!TOMTOM_API_KEY) {
    return {
      source: 'TomTom',
      configured: false,
      message: 'TOMTOM_API_KEY not set — sign up for a free key at developer.tomtom.com and add it to .env',
      incidents: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  // TomTom Traffic Incidents API — bounding box built from a centre point + radius.
  // Approximate degrees-per-metre conversion is fine at this zoom level for Cornwall's latitude.
  const degOffset = radiusMeters / 111320;
  const bbox = [lon - degOffset, lat - degOffset, lon + degOffset, lat + degOffset].join(',');

  const url = new URL('https://api.tomtom.com/traffic/services/5/incidentDetails');
  url.searchParams.set('bbox', bbox);
  url.searchParams.set('fields', '{incidents{type,geometry{type,coordinates},properties{iconCategory,events{description}}}}');
  url.searchParams.set('language', 'en-GB');
  url.searchParams.set('key', TOMTOM_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TomTom request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  return {
    source: 'TomTom',
    configured: true,
    incidents: (data.incidents || []).map((inc) => ({
      description: inc.properties?.events?.[0]?.description || 'Incident',
      category: inc.properties?.iconCategory,
      coordinates: inc.geometry?.coordinates || null,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getTrafficIncidents };
