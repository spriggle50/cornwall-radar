// Verifies the Supabase access token sent as "Authorization: Bearer <token>"
// and attaches the resulting user to req.user. Every account/billing route
// that touches a specific consumer's data goes through this first — nothing
// in this project trusts a consumer id sent by the client itself.
const { supabaseAuth, isConfigured } = require('../lib/supabaseClient');

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

  req.user = { id: data.user.id, email: data.user.email };
  next();
}

module.exports = { requireAuth };
