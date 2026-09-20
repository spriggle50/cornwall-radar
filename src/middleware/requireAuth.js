// Verifies the Supabase access token sent as "Authorization: Bearer <token>"
// and attaches the resulting user to req.user. Every account/billing route
// that touches a specific consumer's data goes through this first — nothing
// in this project trusts a consumer id sent by the client itself.
const { supabaseAuth, isConfigured } = require('../lib/supabaseClient');

// Reads the claims out of a Supabase access token without re-verifying its
// signature — safe to do here because this is only ever called on a token
// that supabaseAuth.auth.getUser() has just confirmed is genuine. This is
// purely to read the `aal` (Authenticator Assurance Level) claim Supabase
// embeds in every access token, so no extra network round trip is needed
// just to check it.
function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

async function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Accounts are not configured on this server yet (SUPABASE_URL / keys missing).' });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data || !data.user) {
    return res.status(401).json({ error: 'Session expired or invalid — please sign in again' });
  }

  // If this account has a VERIFIED authenticator app enrolled (see the
  // "Two-factor authentication" card in index.html), their access token
  // must carry aal2 — i.e. they've actually completed the 6-digit-code
  // challenge this session — not just aal1 from password/magic-link alone.
  // Without this check, MFA would only be a speed bump in the account
  // panel's own UI: an aal1 token obtained before the code challenge would
  // still work against every API route directly, which defeats the point
  // of a second factor. Accounts with no verified factor are completely
  // unaffected — aal1 is the normal, expected level for them.
  const hasVerifiedMfa = Array.isArray(data.user.factors) && data.user.factors.some((f) => f.status === 'verified');
  if (hasVerifiedMfa) {
    const claims = decodeJwtPayload(token);
    if (!claims || claims.aal !== 'aal2') {
      return res.status(401).json({ error: 'Two-factor verification required — please enter your authenticator app code.' });
    }
  }

  req.user = { id: data.user.id, email: data.user.email };
  next();
}

module.exports = { requireAuth };
