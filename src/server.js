require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const dashboardRoute = require('./routes/dashboard');
const accountRoute = require('./routes/account');
const billing = require('./routes/billing');
const businessRoute = require('./routes/business');
const directoryRoute = require('./routes/directory');
const reviewsRoute = require('./routes/reviews');
const adminRoute = require('./routes/admin');
const alertsRoute = require('./routes/alerts');
const { geocodeLocation } = require('./fetchers/geocode');
const { runMorningDigest } = require('./jobs/morningDigest');
const { runAlertEngine } = require('./jobs/alertEngine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Stripe's webhook signature check needs the exact raw request bytes, not
// the parsed JSON body express.json() below would otherwise produce — once
// json() has consumed and parsed the body there's no getting the raw bytes
// back. So this one route is registered BEFORE the global express.json()
// call, with its own express.raw() just for this path. Every other route
// in the app (including the rest of /api/billing) is fine with the normal
// parsed JSON body and is mounted after express.json() as usual.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billing.webhookHandler);

app.use(express.json());

// Serve the PWA frontend — public/ lives one level up from this file (src/),
// i.e. directly at the project root. No sibling-folder / monorepo setup here.
app.use(express.static(path.join(__dirname, '..', 'public')));

// TEMPORARY — diagnosing why /brand and /images 404 in production despite
// being committed to main. Reports exactly what the running container sees
// on disk, since that's the one thing we can't check from outside. Remove
// this route once the images issue is resolved — it's a read-only
// directory listing, not sensitive, but it's clutter that shouldn't stick
// around in the API surface long-term.
app.get('/api/debug-static', (req, res) => {
  const publicDir = path.join(__dirname, '..', 'public');
  const safeList = (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch (err) {
      return { error: err.message };
    }
  };
  res.json({
    resolvedPublicDir: publicDir,
    publicDirExists: fs.existsSync(publicDir),
    publicContents: safeList(publicDir),
    imagesContents: safeList(path.join(publicDir, 'images')),
    brandContents: safeList(path.join(publicDir, 'brand')),
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'cornwall-radar', time: new Date().toISOString() });
});

app.use('/api/dashboard', dashboardRoute);
app.use('/api/account', accountRoute);
app.use('/api/billing', billing.router);
// Phase 3 — the business directory. /business is owner-only (create/edit a
// listing, upgrade to Featured); /directory is the public, no-auth browse
// endpoint everyone (including logged-out visitors) hits to see listings.
app.use('/api/business', businessRoute);
app.use('/api/directory', directoryRoute);
app.use('/api/reviews', reviewsRoute);
// Logged-in admin panel — same moderation as the emailed one-click links
// above, reachable while signed in instead of needing that specific email
// (see middleware/requireAdmin.js for how "admin" is identified).
app.use('/api/admin', adminRoute);
// Alert preferences (morning digest, traffic, weather, wildlife) — actually
// sending them happens in the two cron-triggered jobs below, not here.
app.use('/api/alerts', alertsRoute);

// GET /api/public-config — the handful of values the frontend needs to talk
// to Supabase directly (its anon key is designed to be shared with the
// browser; it can only ever do what that project's RLS policies allow).
// Same pattern as /api/tomtom-key below. Returns null fields rather than
// erroring when accounts aren't set up yet, so the frontend can just show
// "sign-in coming soon" instead of breaking.
app.get('/api/public-config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
});

// GET /api/cron/morning-digest?secret=... — meant to be called by an
// external scheduler roughly once an hour (Railway Cron Job, or a free
// pinger like cron-job.org), not by anything in the frontend. The shared
// secret is the only thing standing between this and anyone on the
// internet triggering real email sends to real subscribers, so it refuses
// to run at all if CRON_SECRET isn't set, rather than falling back to
// "open to everyone."
//
// Kept at this same URL/name (rather than adding a second cron endpoint
// Ady would need to set up a second external pinger for) even though it now
// runs BOTH scheduled jobs — the once-a-day digest and the alert engine's
// traffic/weather/wildlife checks (jobs/alertEngine.js), which are meant to
// run on every hourly hit, not just at each subscriber's chosen digest
// hour. Whatever's already pinging this URL picks up the new behaviour
// automatically on the next deploy — no scheduler config change needed.
app.get('/api/cron/morning-digest', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET not set — refusing to run (this endpoint sends real email to real subscribers).' });
  }
  if (req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const [digest, alerts] = await Promise.all([
      runMorningDigest(),
      runAlertEngine(),
    ]);
    res.json({ digest, alerts });
  } catch (err) {
    console.error('[cron] scheduled run failed:', err.message);
    res.status(500).json({ error: 'Scheduled run failed — see server logs' });
  }
});

// GET /api/geocode?q=<town or postcode> — turns typed text into a lat/lon
// so the location search bar can request conditions for a specific place.
// Exposes the TomTom key so the traffic map's tile layer (flow speed) can be
// requested directly by the browser — this is TomTom's intended usage for
// map tiles (the key is scoped/rate-limited on TomTom's own dashboard, not
// meant to be hidden from the client for this purpose).
app.get('/api/tomtom-key', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ key: process.env.TOMTOM_API_KEY || null });
});

app.get('/api/geocode', async (req, res) => {
  try {
    const result = await geocodeLocation(req.query.q);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Accounts, saved locations, Stripe billing (Phase 1.5), the amenities/
// business directory (Phase 3), and the fuller alert engine (Phase 2 —
// traffic-route/weather-warning/wildlife alerts, plus multiple digests via
// routes/alerts.js) are all wired up above — see Cornwall-Radar-Spec.md §9
// for the full original roadmap.

app.listen(PORT, () => {
  console.log(`Cornwall Radar listening on http://localhost:${PORT}`);
});
