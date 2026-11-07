// Reviews on a business listing — the consumer side (write/edit/remove YOUR
// OWN review). Reading reviews is public and lives in routes/directory.js
// instead (no auth needed to browse them, same as the listings
// themselves); replying to one as the business owner lives in
// routes/business.js. This file covers two ways to leave one:
//
// 1. Signed in (PUT/DELETE /:businessId below, behind requireAuth) — tied
//    to a real consumer_id, one row per business+consumer.
// 2. No account at all (POST /public/:businessId above requireAuth) — like
//    a Google/Yell review link a business can send straight to a customer
//    or put on their own website. Only an email address is asked for (not
//    shown publicly, same as a signed-in reviewer's email never is — see
//    directory.js's own comment on that), used purely so the existing
//    admin new-review alert/remove-it-if-it's-bad flow below still works
//    exactly the same way it already does for a listing added on someone's
//    behalf in business.js's POST /api/admin/businesses. This is
//    deliberately NOT a moderation queue — a review is live the instant
//    it's posted, same as the signed-in path always has been, with removal
//    happening after the fact if it needs to.
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
    .select('id, business_id, consumer_id, reviewer_email, reviewer_name, rating, comment, reply, created_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !review) {
    return res.status(404).send('<p style="font-family: -apple-system, sans-serif;">Review not found — it may already have been removed.</p>');
  }

  // consumer_id is null for a review left without an account (see this
  // file's top comment) — skip the consumers lookup entirely rather than
  // querying with a null id, and fall back to the row's own reviewer_email.
  const [{ data: business }, { data: consumer }] = await Promise.all([
    supabaseAdmin.from('businesses').select('name').eq('id', review.business_id).maybeSingle(),
    review.consumer_id
      ? supabaseAdmin.from('consumers').select('email').eq('id', review.consumer_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const reviewerEmail = (consumer && consumer.email) || review.reviewer_email || 'unknown';

  const removeUrl = `/api/reviews/admin/remove/${encodeURIComponent(review.id)}?token=${encodeURIComponent(req.query.token)}`;
  res.send(`
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; color:#12181a; line-height:1.5;">
      <h2 style="margin-bottom:4px;">${escHtml(business ? business.name : 'Unknown business')}</h2>
      <p style="color:#5b6b6a; margin-top:0;">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</p>
      ${review.comment ? `<p>${escHtml(review.comment)}</p>` : '<p><em>No written comment.</em></p>'}
      ${review.reply ? `<p><strong>Business's reply:</strong> ${escHtml(review.reply)}</p>` : ''}
      <p><strong>Name shown publicly:</strong> ${escHtml(review.reviewer_name || 'Anonymous')}</p>
      <p><strong>Reviewer's email (private):</strong> ${escHtml(reviewerEmail)}</p>
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

// Same slug logic as seoPages.js's own businessPath()/slugify() (and the
// third copy of it in public/index.html's copyBusinessLink feature) — kept
// in sync by hand since none of these three files can share code with each
// other. Purely cosmetic: the redirect below only needs it to land back on
// a tidy-looking URL, the actual page lookup is by id alone.
function slugifyBusinessName(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'listing';
}
function businessPagePath(business) {
  return `/directory/business/${business.id}/${slugifyBusinessName(business.name)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/reviews/public/:businessId — leave a review with no account at
// all, just an email address. A plain HTML <form method="POST"> on the
// business's own page in seoPages.js posts here directly (that page is
// deliberately JS-free, same as its other forms), so this reads a
// form-urlencoded body rather than JSON, and responds with a redirect back
// to that page rather than a JSON body. consumer_id stays null on the
// inserted row — reviewer_email is how this one's identified instead (see
// this file's top comment, and the migration note in business_reviews for
// the schema side of this).
// Accepts both a plain HTML form post (seoPages.js's JS-free business
// page) and a JSON fetch (the review panel embedded in the main
// site/directory in index.html, used by signed-in AND signed-out
// visitors) — same route, same validation and dedupe-by-email behaviour
// either way, just a different response shape (redirect-with-flash vs a
// JSON body) so each caller gets back what it can actually use.
router.post('/public/:businessId', express.json(), express.urlencoded({ extended: false }), async (req, res) => {
  const wantsJson = req.is('application/json');

  const { data: business, error: bizErr } = await supabaseAdmin
    .from('businesses')
    .select('id, name')
    .eq('id', req.params.businessId)
    .maybeSingle();
  if (bizErr || !business) {
    if (wantsJson) return res.status(404).json({ error: 'That business could not be found.' });
    return res.status(404).send('<p style="font-family: -apple-system, sans-serif;">That business could not be found.</p>');
  }

  const backToBusiness = (query) => res.redirect(303, businessPagePath(business) + query);
  const fail = (status, message) => wantsJson
    ? res.status(status).json({ error: message })
    : backToBusiness('?reviewError=' + encodeURIComponent(message));

  const ratingNum = Number((req.body || {}).rating);
  const name = String((req.body || {}).name || '').trim();
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const comment = String((req.body || {}).comment || '').trim();

  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return fail(400, 'Pick a star rating from 1 to 5.');
  }
  // A name is required and shown publicly next to the review (like a
  // Google/Yell reviewer's name) — the email never is (see this file's top
  // comment); it's only ever used for the admin alert/removal flow below.
  if (!name || name.length > 80) {
    return fail(400, 'Enter your name (up to 80 characters).');
  }
  if (!EMAIL_RE.test(email)) {
    return fail(400, 'Enter a valid email address.');
  }

  try {
    // One row per business+email for the anonymous path (mirrors the
    // signed-in path's one row per business+consumer) — resubmitting with
    // the same email edits that row instead of adding a second one, same
    // "save always replaces" shape as everywhere else in this project.
    // Matched by hand (select then update/insert) rather than .upsert()'s
    // onConflict, which targets a plain unique constraint — this dedup is
    // a partial unique INDEX (only applies when consumer_id is null, so it
    // never collides with the signed-in path's own constraint), and
    // PostgREST's upsert can't be pointed at a partial index's predicate.
    const { data: existing } = await supabaseAdmin
      .from('business_reviews')
      .select('id')
      .eq('business_id', business.id)
      .is('consumer_id', null)
      .eq('reviewer_email', email)
      .maybeSingle();

    let reviewId;
    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('business_reviews')
        .update({ reviewer_name: name, rating: ratingNum, comment: comment || null, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      reviewId = data.id;
    } else {
      const { data, error } = await supabaseAdmin
        .from('business_reviews')
        .insert({ business_id: business.id, consumer_id: null, reviewer_email: email, reviewer_name: name, rating: ratingNum, comment: comment || null })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      reviewId = data.id;

      // Only on a genuinely new review, not an edit — same rule the
      // signed-in path below already follows, and the same alert/remove-
      // it email Ady already gets for one of those.
      if (ADMIN_ALERT_EMAIL && ADMIN_ACTION_TOKEN && emailConfigured()) {
        const reviewUrl = `${APP_BASE_URL}/api/reviews/admin/review/${reviewId}?token=${encodeURIComponent(ADMIN_ACTION_TOKEN)}`;
        sendEmail({
          to: ADMIN_ALERT_EMAIL,
          subject: `New review on ${business.name}`,
          html: `
            <div style="font-family: -apple-system, sans-serif; color:#12181a;">
              <p>A new review just went live on Cornwall Radar (left without an account, via the business's own page link):</p>
              <p><strong>${escHtml(business.name)}</strong> — ${'★'.repeat(ratingNum)}${'☆'.repeat(5 - ratingNum)}</p>
              ${comment ? `<p>${escHtml(comment)}</p>` : ''}
              <p><strong>Name shown publicly:</strong> ${escHtml(name)}<br><strong>Reviewer's email (private):</strong> ${escHtml(email)}</p>
              <p><a href="${reviewUrl}">Review it, and remove if needed →</a></p>
            </div>
          `,
        }).catch((e) => console.error('[reviews] new-review alert email failed:', e.message));
      }
    }

    if (wantsJson) return res.json({ ok: true, reviewId });
    return backToBusiness('?reviewed=1');
  } catch (err) {
    console.error('[reviews] public review submission failed:', err.message);
    return fail(500, 'Something went wrong saving your review — please try again.');
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
      .select('id, rating, comment, reviewer_name, created_at, updated_at')
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
  const { rating, comment, name } = req.body || {};
  const ratingNum = Number(rating);
  // Shown publicly next to the review (like a Google/Yell reviewer's
  // name) — there's no name on a consumer's account to fall back to
  // (schema.sql's consumers table only has an email), so every review
  // carries its own display name instead.
  const reviewerName = String(name || '').trim();
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5' });
  }
  if (!reviewerName || reviewerName.length > 80) {
    return res.status(400).json({ error: 'Enter your name (up to 80 characters)' });
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
        reviewer_name: reviewerName,
        rating: ratingNum,
        comment: (comment || '').trim() || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'business_id,consumer_id' })
      .select('id, rating, comment, reviewer_name, created_at, updated_at')
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
            <p><strong>Name shown publicly:</strong> ${escHtml(reviewerName)}<br><strong>Reviewer's email (private):</strong> ${escHtml(req.user.email || '')}</p>
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
