// Shared plain lat/lon great-circle distance helper. The exact same
// haversine formula already lives inline in both lib/cornwallTowns.js
// (nearestTown) and routes/directory.js (aggregateRatings' sibling,
// distanceKm) — pulled out here for the new alert engine (jobs/alertEngine.js)
// rather than adding a third inline copy. The two existing inline copies are
// left exactly as they are (each already shipped and tested) rather than
// risking a refactor of working code just to remove the duplication.
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { distanceKm };
