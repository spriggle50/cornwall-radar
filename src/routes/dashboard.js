const express = require('express');
const router = express.Router();

const { getWeather } = require('../fetchers/weather');
const { getRecentSightings } = require('../fetchers/wildlife');
const { getNews } = require('../fetchers/news');
const { getTrafficIncidents } = require('../fetchers/traffic');
const { getLiveBuses } = require('../fetchers/buses');
const { getTideTimes } = require('../fetchers/tides');
const { getPollen } = require('../fetchers/pollen');
const { getWeatherDetail } = require('../fetchers/googleWeather');
const { getWhatsOn } = require('../fetchers/whatson');
const { getEvents } = require('../fetchers/events');
const { getSport } = require('../fetchers/sport');
const { getCouncilNews } = require('../fetchers/councilnews');
const { getTrainDepartures } = require('../fetchers/trains');
const { getStormOverflows } = require('../fetchers/stormOverflows');
const { getFloodAndRiverLevels } = require('../fetchers/floodMonitoring');
const { getBathingWaterQuality } = require('../fetchers/bathingWater');
const { getOrFetch, TTL_MS } = require('../lib/dashboardCache');

// Same default as weather.js — Truro, Cornwall — used whenever no location
// is specified. Pollen/Google Weather need an actual lat/lon (unlike the
// other fetchers, which have their own internal defaults), so it's resolved
// here once and reused for both.
const DEFAULT_LAT = 50.2632;
const DEFAULT_LON = -5.0510;

// GET /api/dashboard?lat=&lon=
// Aggregates all sources. Each is wrapped so one failing source
// (down API, missing key, network issue) doesn't take down the whole response —
// the free dashboard should degrade gracefully, not error out entirely.
//
// The actual aggregation only ever runs behind dashboardCache's getOrFetch —
// see that file for why. Repeat page loads for the same location within the
// cache TTL are served from memory instead of re-triggering all ~16 fetchers.
router.get('/', async (req, res) => {
  const lat = req.query.lat ? parseFloat(req.query.lat) : undefined;
  const lon = req.query.lon ? parseFloat(req.query.lon) : undefined;
  const effectiveLat = lat != null ? lat : DEFAULT_LAT;
  const effectiveLon = lon != null ? lon : DEFAULT_LON;

  const buildDashboard = async () => {
    const [weather, wildlife, news, traffic, buses, tides, pollen, weatherDetail, whatson, events, sport, councilNews, trains, stormOverflows, floodMonitoring, bathingWater] = await Promise.allSettled([
      getWeather(lat, lon),
      getRecentSightings(),
      getNews(),
      getTrafficIncidents({ lat, lon }),
      getLiveBuses({ lat, lon }),
      getTideTimes({ lat, lon }),
      getPollen(effectiveLat, effectiveLon),
      getWeatherDetail(effectiveLat, effectiveLon),
      getWhatsOn(),
      getEvents({ lat: effectiveLat, lon: effectiveLon }),
      getSport(),
      getCouncilNews(),
      getTrainDepartures({ lat: effectiveLat, lon: effectiveLon }),
      getStormOverflows(),
      getFloodAndRiverLevels({ lat: effectiveLat, lon: effectiveLon }),
      getBathingWaterQuality(),
    ]);

    // On failure, the full error (including any upstream response body — a
    // WAF block page, an HTML error page, etc.) goes to the server logs only.
    // Visitors just see a clean "unavailable" message — nobody hitting the
    // site needs to see "Microsoft-Azure-Application-Gateway/v2" or similar
    // upstream infrastructure detail, and that's still one Railway log line
    // away whenever this needs debugging again.
    const unwrap = (result, label) => {
      if (result.status === 'fulfilled') return result.value;
      console.error(`[dashboard] ${label} failed:`, result.reason && result.reason.message);
      return { source: label, error: 'Temporarily unavailable', unavailable: true };
    };

    return {
      weather: unwrap(weather, 'weather'),
      wildlife: unwrap(wildlife, 'wildlife'),
      news: unwrap(news, 'news'),
      traffic: unwrap(traffic, 'traffic'),
      buses: unwrap(buses, 'buses'),
      tides: unwrap(tides, 'tides'),
      pollen: unwrap(pollen, 'pollen'),
      weatherDetail: unwrap(weatherDetail, 'weatherDetail'),
      whatson: unwrap(whatson, 'whatson'),
      events: unwrap(events, 'events'),
      sport: unwrap(sport, 'sport'),
      councilNews: unwrap(councilNews, 'councilNews'),
      trains: unwrap(trains, 'trains'),
      stormOverflows: unwrap(stormOverflows, 'stormOverflows'),
      floodMonitoring: unwrap(floodMonitoring, 'floodMonitoring'),
      bathingWater: unwrap(bathingWater, 'bathingWater'),
      generatedAt: new Date().toISOString(),
    };
  };

  const { data, cacheHit } = await getOrFetch(effectiveLat, effectiveLon, buildDashboard);
  res.set('X-Cache', cacheHit ? 'HIT' : 'MISS');
  res.json({ ...data, cacheTtlSeconds: TTL_MS / 1000 });
});

module.exports = router;
