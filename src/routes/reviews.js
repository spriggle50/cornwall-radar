// Reviews on a business listing — the consumer side (write/edit/remove YOUR
// OWN review). Reading reviews is public and lives in routes/directory.js
// instead (no auth needed to browse them, same as the listings
// themselves); replying to one as the business owner lives in
// routes/business.js. This file is only the "I signed in, I want to leave
// or change my own review" half.
//
// Sign-in is required on purpose (routes are behind requireAuth below) —
// unlike the listings themselves, which anyone can browse without an
// account. A free-text "leave a review as anyone" form is trivially spammed
// or used by a competitor to leave bad-faith reviews with no trace; tying a
// review to a real consumer_id (one row per business+consumer, enforced by
// schema.sql's unique constraint) makes both far more friction to abuse,
// without needing a full moderation queue.
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { requireAuth } = require('../middleware/requireAuth');
const { sendEmail, isConfigured: emailConfigured } = require('../lib/emailClient');

const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL;
const ADMIN_ACTION_TOKEN = process.env.ADMIN_ACTION_TOKEN;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const escHtml = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// ── Admin moderation: same shape as business.js's new-listing alert — a
// review is public the instant it's saved, no approval gate, so this is
// "notify, then remove after the fact if needed". Deliberately NOT behind
// requireAuth (defined before that middleware below) since there's no
// admin-role concept in this project's Supabase Auth; gated by the same
// ADMIN_ACTION_TOKEN shared secret instead. GET only reads (safe against
// email-client link-scanners that pre-fetch links); the actual delete is a
// POST, only reachable by clicking the button on the page GET renders.
function requireAdminToken(req, res, next) {
  if (!ADMIN_ACTION_TOKEN || req.query.token !== ADMIN_ACTION_TOKEN) {
    return res.status(403).send('Not authorized.');
  }
  next();
}

router.get('/admin/review/:id', requireAdminToken, async (req, res) => {
  const { data: review, error } = await supabaseAdmin
    .from('business_reviews')
    .select('id, business_id, consumer_id, rating, comment, reply, created_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !review) {
    return res.status(404).send('<p style="font-family: -apple-system, sans-serif;">Review not found — it may already have been removed.</p>');
  }

  const [{ data: business }, { data: consumer }] = await Promise.all([
    supabaseAdmin.from('businesses').select('name').eq('id', review.business_id).maybeSingle(),
    supabaseAdmin.from('consumers').select('email').eq('id', review.consumer_id).maybeSingle(),
  ]);

  const removeUrl = `/api/reviews/admin/remove/${encodeURIComponent(review.id)}?token=${encodeURIComponent(req.query.token)}`;
  res.send(`
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; color:#12181a; line-height:1.5;">
      <h2 style="margin-bottom:4px;">${escHtml(business ? business.name : 'Unknown business')}</h2>
      <p style="color:#5b6b6a; margin-top:0;">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</p>
      ${review.comment ? `<p>${escHtml(review.comment)}</p>` : '<p><em>No written comment.</em></p>'}
      ${review.reply ? `<p><strong>Business's reply:</strong> ${escHtml(review.reply)}</p>` : ''}
      <p><strong>Reviewer's login email:</strong> ${escHtml(consumer ? consumer.email : 'unknown')}</p>
      <form method="POST" action="${removeUrl}" onsubmit="return confirm('Remove this review? This can\\'t be undone.');">
        <button type="submit" style="background:#c0392b; color:#fff; border:none; padding:10px 20px; border-radius:6px; font-size:1em; cursor:pointer;">Remove this review</button>
      </form>
    </div>
  `);
});

router.post('/admin/remove/:id', requireAdminToken, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('business_reviews').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.send('<p style="font-family: -apple-system, sans-serif;">Review removed.</p>');
  } catch (err) {
    res.status(500).send('<p style="font-family: -apple-system, sans-serif;">Could not remove review: ' + escHtml(err.message || 'unknown error') + '</p>');
  }
});

router.use(requireAuth);

// GET /api/reviews/:businessId/mine — the caller's own review for this
// business, or null. The public review list (directory.js) deliberately
// doesn't include who wrote what, so this is how the frontend finds "is
// there already a review here to edit" without exposing anyone else's
// identity to do it.
router.get('/:businessId/mine', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('business_reviews')
      .select('id, rating, comment, created_at, updated_at')
      .eq('business_id', req.params.businessId)
      .eq('consumer_id', req.user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ review: data });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not load your review' });
  }
});

// PUT /api/reviews/:businessId — create or update the caller's own review.
// One row per (business, consumer) — see schema.sql's unique constraint —
// so a second submission always edits the first rather than adding a
// duplicate, same "save always replaces" shape as the business listing and
// the morning-digest preference elsewhere in this project.
router.put('/:businessId', async (req, res) => {
  const { rating, comment } = req.body || {};
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5' });
  }

  try {
    const { data: business, error: bizErr } = await supabaseAdmin
      .from('businesses')
      .select('id, name')
      .eq('id', req.params.businessId)
      .maybeSingle();
    if (bizErr) throw new Error(bizErr.message);
    if (!business) return res.status(404).json({ error: 'That business could not be found' });

    const { data: existing } = await supabaseAdmin
      .from('business_reviews')
      .select('id')
      .eq('business_id', req.params.businessId)
      .eq('consumer_id', req.user.id)
      .maybeSingle();

    const { data, error } = await supabaseAdmin
      .from('business_reviews')
      .upsert({
        business_id: req.params.businessId,
        consumer_id: req.user.id,
        rating: ratingNum,
        comment: (comment || '').trim() || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'business_id,consumer_id' })
      .select('id, rating, comment, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);

    // Only alert on a genuinely NEW review, not every edit — same
    // reasoning as the new-listing alert in business.js. Fire-and-forget:
    // a slow/misconfigured mailbox should never delay or fail the
    // reviewer's own save.
    if (!existing && ADMIN_ALERT_EMAIL && ADMIN_ACTION_TOKEN && emailConfigured()) {
      const reviewUrl = `${APP_BASE_URL}/api/reviews/admin/review/${data.id}?token=${encodeURIComponent(ADMIN_ACTION_TOKEN)}`;
      sendEmail({
        to: ADMIN_ALERT_EMAIL,
        subject: `New review on ${business.name}`,
        html: `
          <div style="font-family: -apple-system, sans-serif; color:#12181a;">
            <p>A new review just went live on Cornwall Radar:</p>
            <p><strong>${escHtml(business.name)}</strong> — ${'★'.repeat(ratingNum)}${'☆'.repeat(5 - ratingNum)}</p>
            ${data.comment ? `<p>${escHtml(data.comment)}</p>` : ''}
            <p><a href="${reviewUrl}">Review it, and remove if needed →</a></p>
          </div>
        `,
      }).catch((e) => console.error('[reviews] new-review alert email failed:', e.message));
    }

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save your review' });
  }
});

// DELETE /api/reviews/:businessId — remove the caller's own review.
router.delete('/:businessId', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('business_reviews')
      .delete()
      .eq('business_id', req.params.businessId)
      .eq('consumer_id', req.user.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not remove your review' });
  }
});

module.exports = router;
