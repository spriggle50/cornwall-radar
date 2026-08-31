require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const dashboardRoute = require('./routes/dashboard');
const { geocodeLocation } = require('./fetchers/geocode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the PWA frontend — public/ lives one level up from this file (src/),
// i.e. directly at the project root. No sibling-folder / monorepo setup here.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'cornwall-radar', time: new Date().toISOString() });
});

app.use('/api/dashboard', dashboardRoute);

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

// NOTE: billing (Stripe checkout/webhook/portal), auth, saved locations, and the
// alert-preferences/push routes from the spec are Phase 1.5+ — deliberately not
// built yet. This first cut proves out the live-data core end to end before
// adding accounts and payments on top of it.

app.listen(PORT, () => {
  console.log(`Cornwall Radar listening on http://localhost:${PORT}`);
});
