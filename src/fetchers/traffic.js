// Traffic fetcher — TomTom Traffic Incidents API.
// NEEDS your own free API key — https://developer.tomtom.com/
// Set TOMTOM_API_KEY in your .env / Railway variables once you have one.
//
// Request shape (bbox, fields, language, timeValidityFilter) and the
// incident-mapping logic below are adapted from a separately-run project's
// own already-working TomTom integration — rewritten here as Cornwall
// Radar's own standalone copy, not shared or imported from that project.

const { nearestTown } = require('../lib/cornwallTowns');

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;

// Same default as weather.js — Truro, Cornwall — used whenever no location
// is specified (e.g. the free dashboard's default view with no saved location yet).
const DEFAULT_LAT = 50.2632;
const DEFAULT_LON = -5.0510;

async function getTrafficIncidents({ lat = DEFAULT_LAT, lon = DEFAULT_LON, radiusMeters = 15000 } = {}) {
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
  const minLon = (lon - degOffset).toFixed(4);
  const maxLon = (lon + degOffset).toFixed(4);
  const minLat = (lat - degOffset).toFixed(4);
  const maxLat = (lat + degOffset).toFixed(4);

  // Richer field set (roadNumbers/from/to/magnitudeOfDelay) plus an explicit
  // timeValidityFilter=present — both taken from the known-working reference
  // implementation, since a bare minimal fields list was untested against
  // a real TomTom response.
  const fields = '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,roadNumbers,delay}}}';
  const params = new URLSearchParams({
    key: TOMTOM_API_KEY,
    bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
    fields,
    language: 'en-GB',
    timeValidityFilter: 'present',
  });

  const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`TomTom request failed: ${res.status} ${res.statusText}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  const rawIncidents = data.incidents || [];

  const incidents = rawIncidents
    .map((inc) => {
      const p = inc.properties || {};
      const event = p.events?.[0];
      const roads = (p.roadNumbers || []).join(', ');
      return {
        road: roads || p.from || 'Local road',
        description: event?.description || (p.from && p.to ? `${p.from} to ${p.to}` : 'Incident reported'),
        severity: p.magnitudeOfDelay != null ? p.magnitudeOfDelay : null, // 0=unknown,1=minor,2=moderate,3=major,4=undefined
        coordinates: inc.geometry?.coordinates || null,
      };
    })
    .filter((i) => i.description)
    .slice(0, 10);

  const town = nearestTown(lat, lon);

  return {
    source: 'TomTom',
    configured: true,
    searchedLocation: town ? `within ${Math.round(radiusMeters / 1000)}km of ${town.name}` : 'within range of the searched point',
    incidents,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getTrafficIncidents };
