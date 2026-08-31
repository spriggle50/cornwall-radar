require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const dashboardRoute = require('./routes/dashboard');

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

// NOTE: billing (Stripe checkout/webhook/portal), auth, saved locations, and the
// alert-preferences/push routes from the spec are Phase 1.5+ — deliberately not
// built yet. This first cut proves out the live-data core end to end before
// adding accounts and payments on top of it.

app.listen(PORT, () => {
  console.log(`Cornwall Radar listening on http://localhost:${PORT}`);
});
