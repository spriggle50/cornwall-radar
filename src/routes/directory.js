// GET /api/directory — the public business directory. No sign-in required
// to browse (same "free to view, paid to unlock more" shape as the rest of
// the site) — only managing a listing (routes/business.js) needs auth.
// Featured (paid) listings sort first; ties broken by distance from a given
// lat/lon if one was passed, otherwise alphabetically. Optional `q` (text
// search across name/description) and `category` filters narrow the list.
const express = require('express');
const router = express.Router();
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');

// Same haversine approach as the rest of the project's distance-based
// sorting (e.g. cornwallTowns.js's nearestTown) — plain lat/lon great-circle
// distance, no external geo library needed for Cornwall's scale.
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get('/', async (req, res) => {
  if (!supabaseConfigured()) {
    return res.json({ configured: false, message: 'Accounts/directory not configured on this server yet.', businesses: [] });
  }

  try {
    const { q, category, lat, lon } = req.query;

    let query = supabaseAdmin
      .from('businesses')
      .select('id, name, category, description, phone, website, postcode, lat, lng, logo_url, subscription_status');

    if (category && category.trim()) {
      query = query.ilike('category', category.trim());
    }
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      query = query.or(`name.ilike.${term},description.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const userLat = lat != null ? parseFloat(lat) : null;
    const userLon = lon != null ? parseFloat(lon) : null;

    const businesses = (data || []).map(({ subscription_status, ...b }) => ({
      ...b,
      featured: subscription_status === 'active',
      distanceKm: (userLat != null && userLon != null && b.lat != null && b.lng != null)
        ? Math.round(distanceKm(userLat, userLon, b.lat, b.lng) * 10) / 10
        : null,
    }));

    businesses.sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
      return a.name.localeCompare(b.name);
    });

    res.json({ configured: true, businesses, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[directory] failed:', err.message);
    res.status(500).json({ error: 'Directory temporarily unavailable' });
  }
});

module.exports = router;
