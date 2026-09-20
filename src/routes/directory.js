// GET /api/directory — the public business directory. No sign-in required
// to browse (same "free to view, paid to unlock more" shape as the rest of
// the site) — only managing a listing (routes/business.js) needs auth.
// Featured (paid) listings sort first; ties broken by distance from a given
// lat/lon if one was passed, otherwise alphabetically. Optional `q` (text
// search across name/description) and `category` filters narrow the list.
const express = require('express');
const router = express.Router();
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');
const { BUSINESS_CATEGORIES } = require('../lib/businessCategories');

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

// GET /api/directory/categories — the fixed list a listing's category is
// chosen from (see lib/businessCategories.js), served publicly so the
// frontend can build BOTH the "list your business" form's dropdown and
// the directory's filter dropdown from the exact same list without
// duplicating it in the static HTML/JS. No auth needed — this is just a
// list of strings, not business data.
router.get('/categories', (req, res) => {
  res.json({ categories: BUSINESS_CATEGORIES });
});

// Shared by GET / (bulk, all listed businesses) and GET /:businessId/reviews
// (one business) — turns raw {business_id, rating} rows into a per-business
// {avgRating, reviewCount}. Done here in JS rather than a SQL GROUP BY/AVG
// since supabase-js's query builder has no aggregate support without an RPC
// or a database view, and this project has avoided both so far in favour of
// keeping logic in one place (see lib/supabaseClient.js's module comment).
function aggregateRatings(rows) {
  const byBusiness = {};
  for (const row of rows) {
    if (!byBusiness[row.business_id]) byBusiness[row.business_id] = { sum: 0, count: 0 };
    byBusiness[row.business_id].sum += row.rating;
    byBusiness[row.business_id].count += 1;
  }
  const result = {};
  for (const businessId of Object.keys(byBusiness)) {
    const { sum, count } = byBusiness[businessId];
    result[businessId] = { avgRating: Math.round((sum / count) * 10) / 10, reviewCount: count };
  }
  return result;
}

router.get('/', async (req, res) => {
  if (!supabaseConfigured()) {
    return res.json({ configured: false, message: 'Accounts/directory not configured on this server yet.', businesses: [] });
  }

  try {
    const { q, category, lat, lon, voucher } = req.query;

    let query = supabaseAdmin
      .from('businesses')
      .select('id, name, category, description, phone, website, postcode, lat, lng, logo_url, subscription_status, voucher_title, voucher_description, voucher_expires_at');

    if (category && category.trim()) {
      query = query.ilike('category', category.trim());
    }
    // ?voucher=1 — used by the "Vouchers & Offers" page (any category, not
    // just Days Out & Attractions) to show only listings currently offering
    // one. A voucher with no voucher_expires_at runs indefinitely; one with
    // a past expiry is treated as gone even though the row itself isn't
    // deleted, so an owner doesn't have to remember to clear it the day it lapses.
    if (voucher === '1' || voucher === 'true') {
      const todayKey = new Date().toISOString().slice(0, 10);
      query = query
        .not('voucher_title', 'is', null)
        .or(`voucher_expires_at.is.null,voucher_expires_at.gte.${todayKey}`);
    }
    if (q && q.trim()) {
      // Word-by-word rather than one literal phrase match: the previous
      // version required the whole search string to appear verbatim in
      // name/description, so "fish chips" never matched "The Fish & Chip
      // Shop" (the "&" breaks the substring) and word order/spacing had
      // to line up exactly. Splitting into words and requiring each one
      // to appear SOMEWHERE in name or description (chaining .or() calls,
      // which supabase/PostgREST ANDs together) matches regardless of
      // order, punctuation in between, or which field each word is in.
      // Capped at 6 words — plenty for a business name search, and keeps
      // a pathologically long query from building an enormous filter.
      const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
      for (const word of words) {
        // Strip characters that are meaningful to PostgREST's filter-string
        // syntax (comma separates or-conditions, parentheses group them,
        // % is the ILIKE wildcard) so a stray character in someone's
        // search can't break the query — just drops silently instead.
        const cleaned = word.replace(/[,()%*]/g, '');
        if (!cleaned) continue;
        const term = `%${cleaned}%`;
        query = query.or(`name.ilike.${term},description.ilike.${term}`);
      }
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const businessIds = (data || []).map((b) => b.id);
    const { data: ratingRows } = businessIds.length
      ? await supabaseAdmin.from('business_reviews').select('business_id, rating').in('business_id', businessIds)
      : { data: [] };
    const ratings = aggregateRatings(ratingRows || []);

    const userLat = lat != null ? parseFloat(lat) : null;
    const userLon = lon != null ? parseFloat(lon) : null;
    const todayKey = new Date().toISOString().slice(0, 10);

    const businesses = (data || []).map(({ subscription_status, voucher_title, voucher_description, voucher_expires_at, ...b }) => {
      // Same "not expired" rule as the ?voucher=1 filter above, applied here
      // too so a lapsed voucher never shows as a badge on an ordinary
      // directory/activities row even when this request wasn't filtered to
      // vouchers only.
      const voucherActive = !!voucher_title && (!voucher_expires_at || voucher_expires_at >= todayKey);
      return {
        ...b,
        featured: subscription_status === 'active',
        avgRating: (ratings[b.id] && ratings[b.id].avgRating) || null,
        reviewCount: (ratings[b.id] && ratings[b.id].reviewCount) || 0,
        distanceKm: (userLat != null && userLon != null && b.lat != null && b.lng != null)
          ? Math.round(distanceKm(userLat, userLon, b.lat, b.lng) * 10) / 10
          : null,
        hasVoucher: voucherActive,
        voucherTitle: voucherActive ? voucher_title : null,
        voucherDescription: voucherActive ? voucher_description : null,
        voucherExpiresAt: voucherActive ? voucher_expires_at : null,
      };
    });

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

// GET /api/directory/sponsored?limit=3 — a small, rotating subset of
// Featured businesses for the main dashboard's "Sponsored" strip (a
// separate, higher-visibility spot from the full directory page, which
// already lists every Featured business up top with no need to rotate).
//
// With potentially hundreds of Featured businesses and only a handful of
// slots here, showing "the same first few" every time would make paying
// for Featured pointless for anyone not in that lucky first slice. This
// uses a deterministic, clock-based rotation instead of randomness:
// businesses are pulled in a stable order (by id), time is divided into
// fixed windows (ROTATION_MS), and each window starts at a different
// offset into that list, wrapping around. Over enough windows every
// Featured business gets an equal number of "in a slot" windows — genuine
// fairness, not luck — and (unlike per-visitor randomness) everyone looking
// at the site in the same minute sees the same sponsors, which is both
// simpler to reason about and friendlier to the dashboard's own caching.
const ROTATION_MS = 60 * 1000;

router.get('/sponsored', async (req, res) => {
  if (!supabaseConfigured()) {
    return res.json({ configured: false, businesses: [] });
  }

  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 3, 1), 10);

    const { data, error } = await supabaseAdmin
      .from('businesses')
      .select('id, name, category, description, website, logo_url')
      .eq('subscription_status', 'active')
      .order('id'); // stable, arbitrary-but-fixed order — the rotation offset is what actually varies, not this
    if (error) throw new Error(error.message);

    const featured = data || [];
    if (!featured.length) {
      return res.json({ configured: true, businesses: [] });
    }

    const windowIndex = Math.floor(Date.now() / ROTATION_MS);
    const offset = windowIndex % featured.length;
    const slotCount = Math.min(limit, featured.length);
    const businesses = Array.from({ length: slotCount }, (_, i) => featured[(offset + i) % featured.length]);

    res.json({ configured: true, businesses, rotatesEverySeconds: ROTATION_MS / 1000 });
  } catch (err) {
    console.error('[directory] sponsored failed:', err.message);
    res.status(500).json({ error: 'Sponsored businesses temporarily unavailable' });
  }
});

// GET /api/directory/:businessId/reviews — public list of reviews on one
// business, newest first, plus the average rating. Deliberately excludes
// consumer_id/email — sign-in is required to WRITE a review (see
// routes/reviews.js) to cut down on spam, but that's not the same as
// making reviewers publicly identifiable; nothing here says who wrote what.
router.get('/:businessId/reviews', async (req, res) => {
  if (!supabaseConfigured()) {
    return res.json({ configured: false, reviews: [] });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('business_reviews')
      .select('id, rating, comment, reply, replied_at, created_at')
      .eq('business_id', req.params.businessId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const reviews = data || [];
    const avgRating = reviews.length
      ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
      : null;

    res.json({ configured: true, reviews, avgRating, reviewCount: reviews.length });
  } catch (err) {
    console.error('[directory] reviews failed:', err.message);
    res.status(500).json({ error: 'Reviews temporarily unavailable' });
  }
});

module.exports = router;
