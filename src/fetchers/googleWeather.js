// Extra weather detail fetcher — Google Weather API
// (https://developers.google.com/maps/documentation/weather). This is
// deliberately separate from the Open-Meteo hero at the top of the page:
// Open-Meteo stays the always-on, key-free source that drives the main
// hero and forecast strip, while this adds a second, more detailed layer
// (humidity, dew point, pressure, visibility, cloud cover, wind gusts) that
// only appears in the Weather Details page and only if configured.
//
// Same key as pollen.js (GOOGLE_MAPS_API_KEY) — both need a billing-enabled
// Google Cloud project. Response field names below are per Google's
// documented Weather API contract; read defensively since this project's
// sandbox can't make a live call to double-check the exact shape.

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

async function getWeatherDetail(lat, lon) {
  if (!GOOGLE_MAPS_API_KEY) {
    return {
      source: 'Google Weather API',
      configured: false,
      message: 'GOOGLE_MAPS_API_KEY is not set — add a billing-enabled Google Cloud API key to .env to turn on extended weather detail.',
    };
  }

  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
    'location.latitude': String(lat),
    'location.longitude': String(lon),
  });
  const url = `https://weather.googleapis.com/v1/currentConditions:lookup?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Google Weather API request failed: ${res.status} ${res.statusText}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`);
  }
  const d = await res.json();

  return {
    source: 'Google Weather API',
    configured: true,
    description: d.weatherCondition?.description?.text || null,
    humidityPct: d.relativeHumidity != null ? d.relativeHumidity : null,
    dewPointC: d.dewPoint?.degrees != null ? d.dewPoint.degrees : null,
    pressureMb: d.airPressure?.meanSeaLevelMillibars != null ? d.airPressure.meanSeaLevelMillibars : null,
    visibilityKm: d.visibility?.distance != null ? d.visibility.distance : null,
    cloudCoverPct: d.cloudCover != null ? d.cloudCover : null,
    windGustKph: d.wind?.gust?.value != null ? d.wind.gust.value : null,
    windDirection: d.wind?.direction?.cardinal || null,
    thunderstormChancePct: d.thunderstormProbability != null ? d.thunderstormProbability : null,
    rainChancePct: d.precipitation?.probability?.percent != null ? d.precipitation.probability.percent : null,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getWeatherDetail };
