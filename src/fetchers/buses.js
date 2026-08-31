// Live buses fetcher — Bus Open Data Service (BODS), DfT.
// NEEDS your own free API key — register at https://data.bus-data.dft.gov.uk/
// Set BODS_API_KEY in your .env / Railway variables once you have one.
//
// Confirmed via a real request: /api/v1/datafeed/ requires at least one real
// query parameter beyond api_key (hitting it with only api_key returns a
// "please add some parameters" message, not vehicle data) — boundingBox is
// the parameter that makes it return real Cornwall-only results.

const { XMLParser } = require('fast-xml-parser');

const BODS_API_KEY = process.env.BODS_API_KEY;

// Same Cornwall bounding box as wildlife.js — minLon,minLat,maxLon,maxLat,
// which is the exact order BODS documents for this parameter.
const CORNWALL_BOUNDING_BOX = '-5.75,49.9,-4.2,50.75';

const parser = new XMLParser({ ignoreAttributes: false });

async function getLiveBuses({ boundingBox = CORNWALL_BOUNDING_BOX } = {}) {
  if (!BODS_API_KEY) {
    return {
      source: 'BODS',
      configured: false,
      message: 'BODS_API_KEY not set — register free at data.bus-data.dft.gov.uk and add it to .env',
      vehicles: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  const url = new URL('https://data.bus-data.dft.gov.uk/api/v1/datafeed/');
  url.searchParams.set('api_key', BODS_API_KEY);
  url.searchParams.set('boundingBox', boundingBox);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`BODS request failed: ${res.status} ${res.statusText}`);
  }
  const rawXml = await res.text();

  // SIRI-VM structure: Siri > ServiceDelivery > VehicleMonitoringDelivery > VehicleActivity[]
  // Written against the standard SIRI-VM schema — not yet checked against a
  // real parsed response, since I don't have a key to test with. First thing
  // to verify once this is deployed: does `vehicles` actually come back
  // populated, or does the shape need adjusting to match what BODS sends.
  let vehicles = [];
  try {
    const parsed = parser.parse(rawXml);
    const delivery = parsed?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery;
    const activities = delivery?.VehicleActivity;
    const activityList = Array.isArray(activities) ? activities : (activities ? [activities] : []);

    vehicles = activityList.map((a) => {
      const journey = a.MonitoredVehicleJourney || {};
      const location = journey.VehicleLocation || {};
      return {
        line: journey.PublishedLineName || journey.LineRef || null,
        destination: journey.DestinationName || null,
        lat: location.Latitude != null ? parseFloat(location.Latitude) : null,
        lon: location.Longitude != null ? parseFloat(location.Longitude) : null,
        bearing: journey.Bearing != null ? parseFloat(journey.Bearing) : null,
        recordedAt: a.RecordedAtTime || null,
      };
    });
  } catch (parseErr) {
    // Surface the parse failure rather than silently returning an empty list —
    // if this happens, the XML shape didn't match what's coded above and needs a look.
    return {
      source: 'BODS',
      configured: true,
      error: `Got a response but could not parse it: ${parseErr.message}`,
      vehicles: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  return {
    source: 'BODS',
    configured: true,
    vehicles,
    // TEMPORARY debug field — remove once vehicles[] is confirmed working.
    // Shows the first 800 characters of the real raw response so we can see
    // exactly what shape it's actually in, without hitting BODS directly again.
    debugRawXmlSnippet: vehicles.length === 0 ? rawXml.slice(0, 800) : undefined,
    debugRawXmlLength: rawXml.length,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getLiveBuses };