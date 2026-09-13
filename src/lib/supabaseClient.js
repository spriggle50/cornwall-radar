// Supabase clients for the accounts/billing phase (Phase 1.5).
//
// Two separate clients, deliberately:
//  - `supabaseAdmin` uses the service-role key, which bypasses Row Level
//    Security entirely. Every backend route in this project uses ONLY this
//    client, and enforces "does this row belong to the logged-in user"
//    itself (by filtering every query on consumer_id/id = req.user.id)
//    rather than relying on Postgres RLS. That's a deliberate choice for a
//    small, single-backend project: it keeps all the ownership logic in one
//    place (the route handlers) instead of split between JS and SQL
//    policies. The RLS policies in schema.sql still matter as a backstop —
//    they're what protects the data if this key were ever leaked, or if
//    someone queries Supabase's REST API directly with a user's own token.
//  - `supabaseAuth` uses the public anon key and exists only to verify a
//    user's access token (supabaseAuth.auth.getUser(token)) — it never
//    touches the database directly.
//
// Both are `null` until SUPABASE_URL + the matching key are set, so routes
// that need them can fail with a clear "not configured" message instead of
// crashing the whole server at boot — same pattern as every other optional
// integration in this project (see nationalHighways.js, googleWeather.js).
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const supabaseAuth = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;

const isConfigured = () => !!(supabaseAdmin && supabaseAuth);

module.exports = { supabaseAdmin, supabaseAuth, isConfigured };
