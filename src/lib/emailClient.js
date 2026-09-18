// Sends transactional email via SMTP2GO's HTTP API (https://www.smtp2go.com)
// — a free tier (1,000 emails/month, 200/day) that needs nothing but an API
// key, no SMTP setup. Used for the morning digest; nothing else in this
// project sends email yet. Kept as a plain HTTP call via fetchWithTimeout
// rather than pulling in an SDK, matching how every other integration in
// this project talks to its upstream API.
//
// Note: SMTP2GO requires the `sender` address to be a "Verified Sender"
// (either a verified sending domain, or a single verified email address)
// set up in the SMTP2GO dashboard before it will actually deliver — see
// SMTP2GO_SENDER below.
//
// Note: SMTP2GO returns HTTP 200 even when the send itself failed, so a
// successful-looking response is still checked for data.failed/data.failures.
const { fetchWithTimeout } = require('./fetchWithTimeout');

const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY;
const SMTP2GO_SENDER = process.env.SMTP2GO_SENDER || 'Cornwall Radar <digest@cornwallradar.co.uk>';

const isConfigured = () => !!SMTP2GO_API_KEY;

// 20s rather than fetchWithTimeout's normal 8s default: the dashboard's
// fetchers deliberately fail fast so one slow source never holds up a page
// load, but sending the digest is a one-shot, once-a-day action for a paid
// feature — if SMTP2GO is just a bit slow to respond, it's worth waiting
// longer rather than dropping that subscriber's email for the whole day (the
// morning-digest job only retries a given consumer once their chosen hour
// comes round again tomorrow, so an 8s timeout here was a real risk of
// silently missed sends, not just a slow page).
const SEND_TIMEOUT_MS = 20000;

async function sendEmail({ to, subject, html }) {
  if (!SMTP2GO_API_KEY) {
    throw new Error('SMTP2GO_API_KEY not set — cannot send email');
  }

  const res = await fetchWithTimeout('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Smtp2go-Api-Key': SMTP2GO_API_KEY,
    },
    body: JSON.stringify({
      sender: SMTP2GO_SENDER,
      to: [to],
      subject,
      html_body: html,
    }),
  }, SEND_TIMEOUT_MS);

  const body = await res.json().catch(() => null);

  const failed = body?.data?.failed;
  const failures = body?.data?.failures;
  const ok = res.ok && body && (failed === 0 || failed === undefined) && (!failures || failures.length === 0);

  if (!ok) {
    const reason = body?.data?.error || body?.data?.failures?.[0]?.error || `HTTP ${res.status} ${res.statusText}`;
    throw new Error(`SMTP2GO request failed: ${reason}`);
  }

  return body;
}

module.exports = { sendEmail, isConfigured };
