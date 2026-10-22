// Public one-click unsubscribe for the outreach campaign
// (campaign/send_batch.mjs). No auth — reachable by anyone who clicks the
// link in an outreach email, matched purely by each lead's own
// unsubscribe_token (a random value, one per row — see
// campaign/backfill_unsubscribe_tokens.mjs for how existing rows got
// theirs). Matching on that token rather than the lead's id means this
// link can't be used to unsubscribe a different business by guessing a
// sequential id, and a leaked token only ever affects that one lead.
//
// GET, not POST: this is meant to be clicked straight out of an email body
// by a person, not fired automatically by a mail client's own built-in
// "Unsubscribe" button next to the sender name (that's RFC 8058 one-click
// unsubscribe, which needs a List-Unsubscribe-Post header and a POST
// handler that skips any confirmation page — deliberately not built here
// since this campaign's volume is nowhere near the 5,000-emails/day
// threshold Gmail and Yahoo require it at; worth revisiting if that
// changes).
const express = require('express');
const router = express.Router();
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');
const { sendEmail, isConfigured: emailConfigured } = require('../lib/emailClient');

// Same alert-email pattern as business.js's and reviews.js's own admin
// notifications (new listing / new review) — reused here so Ady hears
// about an unsubscribe the moment it happens, since this route is what
// takes him out of the loop that campaign/unsubscribe.mjs used to require
// him to be in.
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL;

// Same tiny escaper every other route file in this project keeps its own
// copy of — see business.js/reviews.js/seoPages.js for the others.
const escHtml = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(title)} — Cornwall Radar</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #12181a; line-height: 1.5; }
  h2 { margin-bottom: 4px; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

router.get('/unsubscribe/:token', async (req, res) => {
  if (!supabaseConfigured()) {
    return res.status(500).send(page('Unavailable', '<p>Sorry, this isn’t available right now — please email us directly instead.</p>'));
  }
  const token = (req.params.token || '').trim();
  if (!token) {
    return res.status(400).send(page('Invalid link', '<p>That unsubscribe link looks incomplete.</p>'));
  }

  try {
    const { data: lead, error: findErr } = await supabaseAdmin
      .from('leads')
      .select('id, business_name, email, status')
      .eq('unsubscribe_token', token)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!lead) {
      return res.status(404).send(page('Not found', '<p>We couldn’t find a matching subscription for this link — it may be out of date. Email us directly and we’ll sort it.</p>'));
    }

    // Idempotent: clicking an already-used link just shows the same
    // confirmation again rather than erroring, and never re-fires the
    // admin alert for something that already happened.
    if (lead.status !== 'unsubscribed') {
      const { error: updateErr } = await supabaseAdmin
        .from('leads')
        .update({ status: 'unsubscribed' })
        .eq('id', lead.id);
      if (updateErr) throw new Error(updateErr.message);

      console.log(`[campaignUnsubscribe] unsubscribed: ${lead.business_name} <${lead.email}>`);

      if (ADMIN_ALERT_EMAIL && emailConfigured()) {
        sendEmail({
          to: ADMIN_ALERT_EMAIL,
          subject: `Unsubscribed: ${lead.business_name}`,
          html: `
            <div style="font-family: -apple-system, sans-serif; color:#12181a;">
              <p><strong>${escHtml(lead.business_name)}</strong> (${escHtml(lead.email)}) just unsubscribed from the outreach campaign via the link in their email — no action needed, send_batch.mjs will skip this address from now on.</p>
            </div>
          `,
        }).catch((e) => console.error('[campaignUnsubscribe] admin alert email failed:', e.message));
      }
    }

    res.send(page('Unsubscribed', `
      <h2>You’re unsubscribed</h2>
      <p>${escHtml(lead.business_name)} won’t receive any more emails about Cornwall Radar from us. Sorry for the bother!</p>
    `));
  } catch (err) {
    console.error('[campaignUnsubscribe] failed:', err.message);
    res.status(500).send(page('Something went wrong', '<p>Sorry, something went wrong on our end. Please email us directly instead and we’ll remove you by hand.</p>'));
  }
});

module.exports = router;
