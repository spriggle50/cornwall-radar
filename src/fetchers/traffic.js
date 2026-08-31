// Traffic fetcher — combines two independent sources, matching a
// separately-run project's own already-working approach: TomTom (broad
// incident coverage across Cornwall's whole road network) plus National
// Highways (planned/active closures on the trunk roads it manages: A30,
// A38, A39, A390). Each source is fetched and degrades independently — one
// being unconfigured or failing never blocks the other's results, and any
// failure is still surfaced via sourceNotes rather than silently vanishing.
//
// Request shape (bbox, fields, language, timeValidityFilter) and the
// TomTom incident-mapping logic are adapted from that project's own
// already-working TomTom integration — rewritten here as Cornwall Radar's
// own standalone copy, not shared or imported from it.

const { nearestTown } = require('../lib/cornwallTowns');
const { getRoadClosures } = require('./nationalHighways');

const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;

// Same default as weather.js — Truro, Cornwall — used whenever no location
// is specified (e.g. the free dashboard's default view with no saved location yet).
const DEFAULT_LAT = 50.2632;
const DEFAULT_LON = -5.0510;

async function fetchTomTomIncidents(lat, lon, radiusMeters) {
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

  return rawIncidents
    .map((inc) => {
      const p = inc.properties || {};
      const event = p.events?.[0];
      const roads = (p.roadNumbers || []).join(', ');
      return {
        road: roads || p.from || 'Local road',
        description: event?.description || (p.from && p.to ? `${p.from} to ${p.to}` : 'Incident reported'),
        severity: p.magnitudeOfDelay != null ? p.magnitudeOfDelay : null, // 0=unknown,1=minor,2=moderate,3=major,4=undefined
        kind: 'incident',
        // GeoJSON: Point -> [lon, lat]; LineString -> a road-shaped path of
        // [lon, lat] pairs. Kept in GeoJSON's own lon-then-lat order here;
        // the frontend map flips it to Leaflet's lat-then-lon order.
        geometryType: inc.geometry?.type || null,
        coordinates: inc.geometry?.coordinates || null,
      };
    })
    .filter((i) => i.description)
    .slice(0, 15);
}

async function getTrafficIncidents({ lat = DEFAULT_LAT, lon = DEFAULT_LON, radiusMeters = 15000 } = {}) {
  const tomtomConfigured = !!TOMTOM_API_KEY;

  let tomtomIncidents = [];
  let tomtomError = null;
  if (tomtomConfigured) {
    try {
      tomtomIncidents = await fetchTomTomIncidents(lat, lon, radiusMeters);
    } catch (err) {
      tomtomError = err.message;
    }
  }

  let nhClosures = [];
  let nhConfigured = false;
  let nhError = null;
  try {
    const nh = await getRoadClosures();
    nhConfigured = nh.configured;
    if (nh.configured) nhClosures = nh.closures;
  } catch (err) {
    nhConfigured = true; // it had a key and attempted a real request, which then failed
    nhError = err.message;
  }

  if (!tomtomConfigured && !nhConfigured) {
    return {
      source: 'Traffic',
      configured: false,
      message: 'Neither TOMTOM_API_KEY nor NATIONAL_HIGHWAYS_API_KEY is set — add either (or both) to .env. TomTom (developer.tomtom.com) covers all local roads; National Highways (developer.nationalhighways.co.uk) adds trunk-road closures.',
      incidents: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  const town = nearestTown(lat, lon);
  // National Highways' closures listed first, matching the reference
  // implementation's ordering — they're the more targeted, official-source
  // result; TomTom fills in comprehensive local-road coverage after.
  const incidents = [...nhClosures, ...tomtomIncidents];

  const sourceNotes = [];
  if (tomtomError) sourceNotes.push('TomTom: ' + tomtomError);
  if (nhError) sourceNotes.push('National Highways: ' + nhError);

  return {
    source: [tomtomConfigured && 'TomTom', nhConfigured && 'National Highways'].filter(Boolean).join(' + '),
    configured: true,
    searchedLocation: town ? `within ${Math.round(radiusMeters / 1000)}km of ${town.name}` : 'within range of the searched point',
    center: { lat, lon },
    incidents,
    sourceNotes: sourceNotes.length ? sourceNotes : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getTrafficIncidents };
