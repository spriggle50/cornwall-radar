// A fixed list of National Rail stations in Cornwall (plus Gunnislake/
// Calstock, which sit right on the county line at the top of the Tamar
// Valley Line branch), used to turn a raw lat/lon into "nearest station"
// for the live departures board — same flat-earth-approximation pattern as
// cornwallTowns.js, just for stations instead of town centres. CRS codes
// and the station list itself come from the standard National Rail station
// list for Cornwall; coordinates are approximate town/village centres,
// which is accurate enough at Cornwall's scale for "nearest station".

const STATIONS = [
  { name: 'Penzance', crs: 'PNZ', lat: 50.1197, lon: -5.5344 },
  { name: 'St Erth', crs: 'SER', lat: 50.1808, lon: -5.4457 },
  { name: 'St Ives', crs: 'SIV', lat: 50.2101, lon: -5.4802 },
  { name: 'Carbis Bay', crs: 'CBB', lat: 50.1934, lon: -5.4713 },
  { name: 'Lelant', crs: 'LEL', lat: 50.1857, lon: -5.4535 },
  { name: 'Lelant Saltings', crs: 'LTS', lat: 50.1900, lon: -5.4590 },
  { name: 'Hayle', crs: 'HYL', lat: 50.1868, lon: -5.4198 },
  { name: 'Camborne', crs: 'CBN', lat: 50.2117, lon: -5.2985 },
  { name: 'Redruth', crs: 'RED', lat: 50.2333, lon: -5.2247 },
  { name: 'Truro', crs: 'TRU', lat: 50.2632, lon: -5.0510 },
  { name: 'Perranwell', crs: 'PRW', lat: 50.2145, lon: -5.1042 },
  { name: 'Penryn', crs: 'PYN', lat: 50.1706, lon: -5.1053 },
  { name: 'Penmere', crs: 'PNM', lat: 50.1553, lon: -5.0791 },
  { name: 'Falmouth Town', crs: 'FMT', lat: 50.1531, lon: -5.0730 },
  { name: 'Falmouth Docks', crs: 'FAL', lat: 50.1524, lon: -5.0658 },
  { name: 'Par', crs: 'PAR', lat: 50.3535, lon: -4.7071 },
  { name: 'Luxulyan', crs: 'LUX', lat: 50.3878, lon: -4.7411 },
  { name: 'St Austell', crs: 'SAU', lat: 50.3382, lon: -4.7930 },
  { name: 'St Columb Road', crs: 'SCR', lat: 50.4046, lon: -4.9412 },
  { name: 'Quintrell Downs', crs: 'QUI', lat: 50.4056, lon: -5.0459 },
  { name: 'Roche', crs: 'ROC', lat: 50.4056, lon: -4.8383 },
  { name: 'Bugle', crs: 'BGL', lat: 50.3899, lon: -4.7999 },
  { name: 'Newquay', crs: 'NQY', lat: 50.4155, lon: -5.0862 },
  { name: 'Lostwithiel', crs: 'LOS', lat: 50.4083, lon: -4.6667 },
  { name: 'Bodmin Parkway', crs: 'BOD', lat: 50.4614, lon: -4.6469 },
  { name: 'Liskeard', crs: 'LSK', lat: 50.4557, lon: -4.4649 },
  { name: 'Causeland', crs: 'CAU', lat: 50.4126, lon: -4.4633 },
  { name: 'Sandplace', crs: 'SDP', lat: 50.3915, lon: -4.4658 },
  { name: 'Coombe Junction Halt', crs: 'COE', lat: 50.3717, lon: -4.4655 },
  { name: 'St Keyne Wishing Well Halt', crs: 'SKN', lat: 50.4258, lon: -4.4762 },
  { name: 'Looe', crs: 'LOO', lat: 50.3512, lon: -4.4534 },
  { name: 'Menheniot', crs: 'MEN', lat: 50.4436, lon: -4.3971 },
  { name: 'St Germans', crs: 'SGM', lat: 50.3925, lon: -4.3053 },
  { name: 'Saltash', crs: 'STS', lat: 50.4062, lon: -4.2018 },
  { name: 'Gunnislake', crs: 'GSL', lat: 50.5183, lon: -4.2136 },
  { name: 'Calstock', crs: 'CSK', lat: 50.4964, lon: -4.2077 },
];

// Flat-earth approximation — fine at Cornwall's scale (~130km across),
// same formula as cornwallTowns.js.
function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon = (lon2 - lon1) * 111.32 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function nearestStation(lat, lon) {
  if (lat == null || lon == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const station of STATIONS) {
    const d = distanceKm(lat, lon, station.lat, station.lon);
    if (d < bestDist) {
      bestDist = d;
      best = station;
    }
  }
  if (!best) return null;
  return { name: best.name, crs: best.crs, distanceKm: Math.round(bestDist * 10) / 10 };
}

module.exports = { nearestStation, STATIONS };
