// Forward geocoding — turns a typed town/postcode into a lat/lon, so the
// dashboard can show conditions for a place the visitor actually cares
// about instead of always defaulting to Truro / the whole county.
// Uses Nominatim (OpenStreetMap), same free keyless service already used
// for reverse-geocoding in wildlife.js. Restricted to Cornwall via a
// bounding box + countrycodes filter so "Truro" doesn't match Truro,
// Nova Scotia.

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

// Cornwall bounding box, same as wildlife.js/buses.js — minLon,minLat,maxLon,maxLat
const CORNWALL_VIEWBOX = '-5.75,50.75,-4.2,49.9';

async function geocodeLocation(query) {
  if (!query || !query.trim()) {
    throw new Error('No location given');
  }

  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'gb');
  url.searchParams.set('viewbox', CORNWALL_VIEWBOX);
  url.searchParams.set('bounded', '1');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'CornwallRadar/0.1 (contact: set-your-contact-email-in-env)' },
  });
  if (!res.ok) {
    throw new Error(`Nominatim request failed: ${res.status} ${res.statusText}`);
  }
  const results = await res.json();
  if (!results || results.length === 0) {
    throw new Error(`Could not find "${query}" in Cornwall`);
  }

  const match = results[0];
  return {
    label: match.display_name.split(',').slice(0, 2).join(',').trim(),
    lat: parseFloat(match.lat),
    lon: parseFloat(match.lon),
  };
}

module.exports = { geocodeLocation };
