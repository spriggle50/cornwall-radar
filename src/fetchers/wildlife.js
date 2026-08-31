// Wildlife sightings fetcher — GBIF (Global Biodiversity Information Facility)
// https://www.gbif.org/developer/summary — free, no API key required.
// Nominatim (OpenStreetMap) used only if/when reverse-geocoding a sighting's
// coordinates into a human-readable place name is needed for display.

const GBIF_OCCURRENCE_URL = 'https://api.gbif.org/v1/occurrence/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

// Roughly Cornwall's bounding box (decimalLatitude/decimalLongitude filters)
const CORNWALL_BOUNDS = {
  minLat: 49.9, maxLat: 50.75,
  minLon: -5.75, maxLon: -4.2,
};

async function getRecentSightings({ limit = 20 } = {}) {
  const url = new URL(GBIF_OCCURRENCE_URL);
  url.searchParams.set('decimalLatitude', `${CORNWALL_BOUNDS.minLat},${CORNWALL_BOUNDS.maxLat}`);
  url.searchParams.set('decimalLongitude', `${CORNWALL_BOUNDS.minLon},${CORNWALL_BOUNDS.maxLon}`);
  url.searchParams.set('hasCoordinate', 'true');
  url.searchParams.set('kingdomKey', '1'); // Animalia
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'eventDate');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'CornwallRadar/0.1 (contact: set-your-contact-email-in-env)' },
  });
  if (!res.ok) {
    throw new Error(`GBIF request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  return {
    source: 'GBIF',
    sightings: (data.results || []).map((r) => ({
      species: r.vernacularName || r.species || r.scientificName || 'Unknown species',
      scientificName: r.scientificName,
      date: r.eventDate,
      lat: r.decimalLatitude,
      lon: r.decimalLongitude,
      locality: r.locality || r.municipality || null,
      recordedBy: r.recordedBy || null,
      // Both come straight from GBIF's own record — used to link out to
      // GBIF's species page (background/photos/taxonomy) and to this
      // specific occurrence record (who logged it, exact source), rather
      // than leaving a sighting as unclickable plain text.
      gbifOccurrenceId: r.key || null,
      gbifSpeciesKey: r.speciesKey || null,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

// Optional helper — only call this for sightings that lack a locality name,
// and respect Nominatim's usage policy (max 1 req/sec, valid User-Agent,
// cache results — do not call this in a tight loop over many sightings).
async function reverseGeocode(lat, lon) {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lon);
  url.searchParams.set('format', 'jsonv2');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'CornwallRadar/0.1 (contact: set-your-contact-email-in-env)' },
  });
  if (!res.ok) {
    throw new Error(`Nominatim request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.display_name || null;
}

module.exports = { getRecentSightings, reverseGeocode };
