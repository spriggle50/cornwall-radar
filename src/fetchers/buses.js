// Live buses fetcher — Bus Open Data Service (BODS), DfT.
// NEEDS your own free API key — register at https://data.bus-data.dft.gov.uk/
// This module is structured but deliberately not wired to live data yet.
// Set BODS_API_KEY in your .env once you have one.

const BODS_API_KEY = process.env.BODS_API_KEY;

async function getLiveBuses({ boundingBox } = {}) {
  if (!BODS_API_KEY) {
    return {
      source: 'BODS',
      configured: false,
      message: 'BODS_API_KEY not set — register free at data.bus-data.dft.gov.uk and add it to .env',
      vehicles: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  // BODS SIRI-VM (real-time vehicle positions) endpoint — bounding box filter.
  const url = new URL('https://data.bus-data.dft.gov.uk/api/v1/datafeed/');
  url.searchParams.set('api_key', BODS_API_KEY);
  if (boundingBox) {
    url.searchParams.set('boundingBox', boundingBox); // "minLon,minLat,maxLon,maxLat"
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`BODS request failed: ${res.status} ${res.statusText}`);
  }
  // BODS returns SIRI-VM XML, not JSON — a real implementation needs an XML
  // parser here (e.g. fast-xml-parser) to pull out VehicleActivity entries.
  // Left as a clear next step rather than guessing the parsing without being
  // able to test it against a real response in this environment.
  const rawXml = await res.text();

  return {
    source: 'BODS',
    configured: true,
    raw: rawXml.slice(0, 0), // placeholder — parse rawXml into vehicles[] once tested against a real key
    vehicles: [],
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getLiveBuses };
