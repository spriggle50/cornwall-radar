// A small fixed list of Cornwall town centres, used to label a raw lat/lon
// with a human-readable "near <town>" name without any extra network call —
// avoids hammering Nominatim's free reverse-geocoding service for every
// bus/incident on every dashboard refresh (its usage policy asks for at
// most ~1 request/sec and discourages exactly this kind of bulk lookup).

const TOWNS = [
  { name: 'Truro', lat: 50.2632, lon: -5.0510 },
  { name: 'Falmouth', lat: 50.1524, lon: -5.0658 },
  { name: 'Penzance', lat: 50.1186, lon: -5.5370 },
  { name: 'St Austell', lat: 50.3382, lon: -4.7930 },
  { name: 'Newquay', lat: 50.4155, lon: -5.0862 },
  { name: 'Bodmin', lat: 50.4720, lon: -4.7191 },
  { name: 'Camborne', lat: 50.2117, lon: -5.2985 },
  { name: 'Redruth', lat: 50.2333, lon: -5.2247 },
  { name: 'Liskeard', lat: 50.4557, lon: -4.4649 },
  { name: 'Launceston', lat: 50.6357, lon: -4.3620 },
  { name: 'Saltash', lat: 50.4062, lon: -4.2018 },
  { name: 'Helston', lat: 50.1004, lon: -5.2740 },
  { name: 'Bude', lat: 50.8295, lon: -4.5432 },
  { name: 'Wadebridge', lat: 50.5170, lon: -4.8317 },
  { name: 'St Ives', lat: 50.2145, lon: -5.4802 },
  { name: 'Hayle', lat: 50.1868, lon: -5.4198 },
  { name: 'Fowey', lat: 50.3355, lon: -4.6382 },
  { name: 'Looe', lat: 50.3512, lon: -4.4534 },
  { name: 'Padstow', lat: 50.5419, lon: -4.9370 },
  { name: 'St Just', lat: 50.1246, lon: -5.6772 },
  { name: 'Callington', lat: 50.5027, lon: -4.3153 },
  { name: 'Torpoint', lat: 50.3757, lon: -4.1919 },
  { name: 'Perranporth', lat: 50.3453, lon: -5.1520 },
  { name: 'Camelford', lat: 50.6188, lon: -4.6949 },
  { name: 'St Columb Major', lat: 50.4342, lon: -4.9382 },
];

// Flat-earth approximation — fine at Cornwall's scale (~130km across).
function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon = (lon2 - lon1) * 111.32 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function nearestTown(lat, lon) {
  if (lat == null || lon == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const town of TOWNS) {
    const d = distanceKm(lat, lon, town.lat, town.lon);
    if (d < bestDist) {
      bestDist = d;
      best = town;
    }
  }
  if (!best) return null;
  return { name: best.name, distanceKm: Math.round(bestDist * 10) / 10 };
}

module.exports = { nearestTown, TOWNS };
