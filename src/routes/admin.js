// Logged-in admin panel — a second way to do the exact same moderation as
// the emailed one-click links (business.js's and reviews.js's own
// /admin/review/:id + /admin/remove/:id routes), for when Ady is signed in
// but can't find or doesn't have the original email to hand. Same admin
// identity (ADMIN_ALERT_EMAIL, see middleware/requireAdmin.js) and the same
// underlying delete — this is not a second, separate moderation system,
// just a second door into the same one. Behind requireAuth + requireAdmin
// on every route in this file.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');
const { requireAdmin } = require('../middleware/requireAdmin');

router.use(requireAuth, requireAdmin);

// GET /api/admin/businesses — every business listing, newest first. Includes
// the owner's login email (same information the emailed moderation link
// already shows) — this endpoint only ever answers to the admin, so there's
// no privacy concern in exposing it here that doesn't already exist there.
router.get('/businesses', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('businesses')
      .select('id, name, category, postcode, email, subscription_status, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ businesses: data || [] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load listings' });
  }
});

// DELETE /api/admin/businesses/:id — same effect as clicking "Remove this
// listing" on the emailed moderation page, just reachable while signed in.
router.delete('/businesses/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('businesses').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove listing' });
  }
});

// GET /api/admin/reviews — every review across every business, newest
// first, with the business name and reviewer's login email attached. Joined
// in JS from three separate queries (business_reviews, then businesses and
// consumers batched by id) rather than a PostgREST embedded select, matching
// this project's established "logic in JS, not in the query layer" approach
// (see lib/supabaseClient.js's module comment, and reviews.js's own admin
// route which does the same two-lookup pattern for a single review).
router.get('/reviews', async (req, res) => {
  try {
    const { data: reviews, error } = await supabaseAdmin
      .from('business_reviews')
      .select('id, business_id, consumer_id, rating, comment, reply, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const rows = reviews || [];
    const businessIds = [...new Set(rows.map((r) => r.business_id))];
    const consumerIds = [...new Set(rows.map((r) => r.consumer_id))];

    const [{ data: businesses }, { data: consumers }] = await Promise.all([
      businessIds.length
        ? supabaseAdmin.from('businesses').select('id, name').in('id', businessIds)
        : Promise.resolve({ data: [] }),
      consumerIds.length
        ? supabaseAdmin.from('consumers').select('id, email').in('id', consumerIds)
        : Promise.resolve({ data: [] }),
    ]);
    const businessNames = Object.fromEntries((businesses || []).map((b) => [b.id, b.name]));
    const consumerEmails = Object.fromEntries((consumers || []).map((c) => [c.id, c.email]));

    const result = rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      businessName: businessNames[r.business_id] || 'Unknown business',
      reviewerEmail: consumerEmails[r.consumer_id] || 'unknown',
      rating: r.rating,
      comment: r.comment,
      reply: r.reply,
      createdAt: r.created_at,
    }));
    res.json({ reviews: result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load reviews' });
  }
});

// DELETE /api/admin/reviews/:id — same effect as the emailed moderation
// page's "Remove this review".
router.delete('/reviews/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('business_reviews').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove review' });
  }
});

module.exports = router;
