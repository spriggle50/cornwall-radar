const express = require('express');
const router = express.Router();

const { getWeather } = require('../fetchers/weather');
const { getRecentSightings } = require('../fetchers/wildlife');
const { getNews } = require('../fetchers/news');
const { getTrafficIncidents } = require('../fetchers/traffic');
const { getLiveBuses } = require('../fetchers/buses');
const { getTideTimes } = require('../fetchers/tides');

// GET /api/dashboard?lat=&lon=
// Aggregates all five sources. Each is wrapped so one failing source
// (down API, missing key, network issue) doesn't take down the whole response —
// the free dashboard should degrade gracefully, not error out entirely.
router.get('/', async (req, res) => {
  const lat = req.query.lat ? parseFloat(req.query.lat) : undefined;
  const lon = req.query.lon ? parseFloat(req.query.lon) : undefined;

  const [weather, wildlife, news, traffic, buses, tides] = await Promise.allSettled([
    getWeather(lat, lon),
    getRecentSightings(),
    getNews(),
    getTrafficIncidents({ lat, lon }),
    getLiveBuses({ lat, lon }),
    getTideTimes({ lat, lon }),
  ]);

  const unwrap = (result, label) =>
    result.status === 'fulfilled'
      ? result.value
      : { source: label, error: result.reason.message, unavailable: true };

  res.json({
    weather: unwrap(weather, 'weather'),
    wildlife: unwrap(wildlife, 'wildlife'),
    news: unwrap(news, 'news'),
    traffic: unwrap(traffic, 'traffic'),
    buses: unwrap(buses, 'buses'),
    tides: unwrap(tides, 'tides'),
    generatedAt: new Date().toISOString(),
  });
});

module.exports = router;
