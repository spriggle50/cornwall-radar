// Live buses fetcher — Bus Open Data Service (BODS), DfT.
// NEEDS your own free API key — register at https://data.bus-data.dft.gov.uk/
// Set BODS_API_KEY in your .env / Railway variables once you have one.
//
// Confirmed via a real request: /api/v1/datafeed requires at least one real
// query parameter beyond api_key (hitting it with only api_key returns a
// "please add some parameters" message, not vehicle data) — boundingBox is
// the parameter that makes it return real Cornwall-only results.
//
// Parsing approach: plain regex over the raw SIRI-VM XML, extracting each
// <VehicleActivity> block and then pulling fields out of it directly,
// rather than a full XML parser. This is adapted from a separately-run
// project's own already-working BODS integration (rewritten here as
// Cornwall Radar's own standalone copy — nothing imported or shared) after
// an XML-parser-based version kept coming back empty against the real BODS
// feed despite matching the documented SIRI-VM schema; regex against the
// confirmed-working reference avoids trusting an unverified schema.

const { nearestTown } = require('../lib/cornwallTowns');

const BODS_API_KEY = process.env.BODS_API_KEY;

// Same Cornwall bounding box as wildlife.js — minLon,minLat,maxLon,maxLat,
// which is the exact order BODS documents for this parameter. Used when no
// specific location was searched for.
const CORNWALL_BOUNDING_BOX = '-5.75,49.9,-4.2,50.75';

// Destination names some vehicles report that aren't real passenger
// destinations (out-of-service or depot-positioning runs) — filtered out
// so the dashboard only shows genuine live routes.
const JUNK_DESTINATIONS = ['nowhere', 'not in service', 'pos', 'depot', 'garage'];

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}

async function getLiveBuses({ lat, lon, boundingBox } = {}) {
  if (!BODS_API_KEY) {
    return {
      source: 'BODS',
      configured: false,
      message: 'BODS_API_KEY not set — register free at data.bus-data.dft.gov.uk and add it to .env',
      vehicles: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  // If a specific location was given, search a ~25km box around it (same
  // proportions as the reference implementation's per-point box) instead of
  // the whole county — a tighter, more relevant result set for that search.
  let box = boundingBox || CORNWALL_BOUNDING_BOX;
  let searchedLocation = 'Cornwall-wide';
  if (!boundingBox && lat != null && lon != null) {
    const minLon = (lon - 0.25).toFixed(4);
    const maxLon = (lon + 0.25).toFixed(4);
    const minLat = (lat - 0.15).toFixed(4);
    const maxLat = (lat + 0.15).toFixed(4);
    box = `${minLon},${minLat},${maxLon},${maxLat}`;
    const town = nearestTown(lat, lon);
    searchedLocation = town ? `near ${town.name}` : 'your searched location';
  }

  const url = `https://data.bus-data.dft.gov.uk/api/v1/datafeed?boundingBox=${box}&api_key=${BODS_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`BODS request failed: ${res.status} ${res.statusText}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`);
  }
  const rawXml = await res.text();

  // Extract each <VehicleActivity>...</VehicleActivity> block, then pull
  // the fields we need straight out of the block text.
  const activityRegex = /<VehicleActivity>([\s\S]*?)<\/VehicleActivity>/g;
  const rawBlocks = [];
  let match;
  while ((match = activityRegex.exec(rawXml)) !== null && rawBlocks.length < 400) {
    rawBlocks.push(match[1]);
  }

  const vehicles = rawBlocks
    .map((block) => {
      const rawDest = block.match(/<DestinationName>(.*?)<\/DestinationName>/)?.[1] || '';
      const rawLat = block.match(/<Latitude>(.*?)<\/Latitude>/)?.[1];
      const rawLon = block.match(/<Longitude>(.*?)<\/Longitude>/)?.[1];
      const arrivalRaw = block.match(/<DestinationAimedArrivalTime>(.*?)<\/DestinationAimedArrivalTime>/)?.[1];
      const recordedRaw = block.match(/<RecordedAtTime>(.*?)<\/RecordedAtTime>/)?.[1];
      const vLat = rawLat ? parseFloat(rawLat) : null;
      const vLon = rawLon ? parseFloat(rawLon) : null;
      const near = vLat != null && vLon != null ? nearestTown(vLat, vLon) : null;

      return {
        line:
          block.match(/<PublishedLineName>(.*?)<\/PublishedLineName>/)?.[1] ||
          block.match(/<LineRef>(.*?)<\/LineRef>/)?.[1] ||
          '',
        destination: rawDest.replace(/_/g, ' ').trim(),
        // Roughly where this vehicle currently is, not where it's headed —
        // BODS gives a live position, not a stop name, so "near <town>"
        // (nearest of a fixed town list, ~a few km precision) is the
        // clearest thing we can show without a full stops database.
        nearLocation: near ? near.name : null,
        mapUrl: vLat != null && vLon != null ? `https://www.google.com/maps?q=${vLat},${vLon}` : '',
        arrivalTime: formatTime(arrivalRaw), // when it's due at its final destination
        updatedTime: formatTime(recordedRaw), // how fresh this exact position is
      };
    })
    .filter((b) => b.line && b.destination)
    .filter((b) => !JUNK_DESTINATIONS.includes(b.destination.toLowerCase()) && b.destination.length > 3)
    // De-duplicate by line+destination — many individual vehicles can be
    // running the same route; a county-wide dashboard just needs a sense
    // of what's active right now, not every physical vehicle.
    .filter((b, i, arr) => arr.findIndex((x) => x.line === b.line && x.destination === b.destination) === i)
    .slice(0, 15);

  return {
    source: 'BODS',
    configured: true,
    searchedLocation,
    vehicles,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getLiveBuses };
