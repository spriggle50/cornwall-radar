// Resend delivery webhook — catches a REAL mail-server bounce or spam
// complaint on the outreach campaign leads (campaign/send_batch.mjs).
//
// This is deliberately separate from that script's own validation_error
// handling: Resend rejects a malformed address like a truncated domain
// immediately, on the send() call itself, before ever attempting delivery
// — send_batch.mjs catches that case synchronously and marks the lead
// 'bounced' right there. A real bounce (mailbox doesn't exist, domain
// doesn't accept mail, full inbox, etc.) only happens AFTER Resend has
// already accepted the send and attempted delivery, so it can only ever
// reach us later, out of band, as a webhook call like this one.
//
// Resend calls this directly — no Authorization header, no user session —
// so authenticity is established purely by the Svix signature check below,
// using the raw request body server.js hands this route (see its mount
// comment for why that has to happen before the app-wide express.json()).
const { Webhook } = require('svix');
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

// A transient ("Soft"/"Transient") bounce is a temporary delivery problem —
// a full inbox, the receiving server being briefly down — not a dead
// address, so it's logged but left alone rather than permanently pulled
// out of the sending queue. Only a Permanent bounce or a spam complaint
// does that.
function isPermanentFailure(event) {
  if (event.type === 'email.complained') return true;
  if (event.type === 'email.bounced') return event.data?.bounce?.type === 'Permanent';
  return false;
}

function describeFailure(event) {
  if (event.type === 'email.complained') {
    return 'Recipient marked this as spam (Resend email.complained)';
  }
  const bounce = event.data?.bounce || {};
  const parts = [bounce.type || 'Unknown', 'bounce'];
  if (bounce.subType) parts.push(`(${bounce.subType})`);
  return `${parts.join(' ')}: ${bounce.message || 'no further detail given'}`;
}

async function webhookHandler(req, res) {
  if (!WEBHOOK_SECRET) {
    console.error('[resendWebhook] RESEND_WEBHOOK_SECRET not set — rejecting webhook.');
    return res.status(500).send('Not configured');
  }

  let event;
  try {
    const wh = new Webhook(WEBHOOK_SECRET);
    // req.body is the raw Buffer express.raw() gave us in server.js — Svix
    // needs the exact original bytes, same requirement as Stripe's check
    // in billing.js, and for the same reason.
    event = wh.verify(req.body, {
      'svix-id': req.header('svix-id'),
      'svix-timestamp': req.header('svix-timestamp'),
      'svix-signature': req.header('svix-signature'),
    });
  } catch (err) {
    console.error('[resendWebhook] signature check failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  // Always acknowledge once the signature is verified, even if our own
  // handling below hits a problem — Resend retries on a non-2xx response,
  // and retrying won't fix a bug on our end, just resend the same event.
  res.status(200).send('ok');

  try {
    await handleEvent(event);
  } catch (err) {
    console.error(`[resendWebhook] handler failed for ${event.type}:`, err.message);
  }
}

async function handleEvent(event) {
  if (event.type !== 'email.bounced' && event.type !== 'email.complained') return;
  if (!supabaseConfigured()) return;
  if (!isPermanentFailure(event)) {
    console.log(`[resendWebhook] ignoring transient/non-permanent ${event.type} for email_id ${event.data?.email_id || '(none)'}`);
    return;
  }

  const emailId = event.data?.email_id || null;
  const recipients = (Array.isArray(event.data?.to) ? event.data.to : [])
    .map((addr) => String(addr).trim().toLowerCase())
    .filter(Boolean);

  // Match on resend_message_id first — that's the exact id send_batch.mjs
  // stored against this one lead when it sent, so it can't cross-match a
  // different lead that happens to share an address. Recipient email is
  // only a fallback for an event that somehow arrives without an email_id.
  let query = supabaseAdmin.from('leads').update({
    status: 'bounced',
    last_error: describeFailure(event),
  });
  if (emailId) {
    query = query.eq('resend_message_id', emailId);
  } else if (recipients.length) {
    query = query.in('email', recipients);
  } else {
    console.error('[resendWebhook] event had neither email_id nor recipients — nothing to match on.');
    return;
  }

  const { data: updated, error } = await query.select('id, business_name, email');
  if (error) throw new Error(error.message);

  if (!updated || !updated.length) {
    console.log(`[resendWebhook] ${event.type} for email_id ${emailId || '(none)'} / ${recipients.join(', ') || '(none)'} matched no campaign lead — probably not from this list.`);
    return;
  }
  for (const lead of updated) {
    console.log(`[resendWebhook] marked bounced: ${lead.business_name} <${lead.email}> (${event.type})`);
  }
}

module.exports = { webhookHandler };
