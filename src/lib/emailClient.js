// Sends transactional email via Resend (https://resend.com) — a generous
// free tier (100 emails/day, 3,000/month) that needs nothing but an API
// key, no SMTP setup. Used for the morning digest; nothing else in this
// project sends email yet. Kept as a plain HTTP call via fetchWithTimeout
// rather than pulling in Resend's own SDK, matching how every other
// integration in this project talks to its upstream API.
const { fetchWithTimeout } = require('./fetchWithTimeout');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Cornwall Radar <digest@cornwallradar.co.uk>';

const isConfigured = () => !!RESEND_API_KEY;

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not set — cannot send email');
  }

  const res = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend request failed: ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }

  return res.json();
}

module.exports = { sendEmail, isConfigured };
