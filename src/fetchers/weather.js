// Weather fetcher — Open-Meteo (https://open-meteo.com)
// Free, no API key required, commercial-use friendly attribution required (see README).
// Default location: Truro, Cornwall (central-ish reference point). A real per-user
// location will be passed in once saved_locations exist (Phase 2).

const { fetchWithTimeout } = require('../lib/fetchWithTimeout');

const DEFAULT_LAT = 50.2632;
const DEFAULT_LON = -5.0510;

async function getWeather(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  // wind_gusts_10m added for the alert engine's high-wind check
  // (jobs/alertEngine.js) — UK wind warnings are gust-based, not sustained-
  // speed-based, and wind_speed_10m alone understates genuinely disruptive
  // gusty conditions. Purely additive: every existing field/consumer of
  // this function (the dashboard, the morning digest) is untouched.
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,is_day');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,uv_index_max');
  // Hourly block — purely additive again, used for the new "next 24 hours"
  // strip (hourlyNext24 below). forecast_days already covers a full week,
  // so there's always at least 24h of hourly data ahead of "now" to slice.
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code,is_day');
  url.searchParams.set('timezone', 'Europe/London');
  url.searchParams.set('forecast_days', '7');

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  return {
    source: 'Open-Meteo',
    location: { lat, lon },
    current: {
      code: data.current.weather_code,
      tempC: data.current.temperature_2m,
      feelsLikeC: data.current.apparent_temperature,
      windKph: data.current.wind_speed_10m,
      windGustsKph: data.current.wind_gusts_10m,
      precipitationMm: data.current.precipitation,
      isDay: !!data.current.is_day,
      condition: describeWeatherCode(data.current.weather_code),
      emoji: weatherEmoji(data.current.weather_code, !!data.current.is_day),
      uvIndexMax: data.daily.uv_index_max ? data.daily.uv_index_max[0] : null,
    },
    forecast: data.daily.time.map((date, i) => ({
      date,
      code: data.daily.weather_code[i],
      maxTempC: data.daily.temperature_2m_max[i],
      minTempC: data.daily.temperature_2m_min[i],
      rainChancePct: data.daily.precipitation_probability_max[i],
      condition: describeWeatherCode(data.daily.weather_code[i]),
      emoji: weatherEmoji(data.daily.weather_code[i], true),
      uvIndexMax: data.daily.uv_index_max ? data.daily.uv_index_max[i] : null,
    })),
    hourlyNext24: buildHourlyNext24(data),
    fetchedAt: new Date().toISOString(),
  };
}

// Open-Meteo's hourly arrays cover the whole forecast_days window, indexed
// in lockstep by data.hourly.time[i] — this just finds "now" in that array
// (current.time is in the same Europe/London-local, no-offset format as
// hourly.time, so a direct string comparison works) and slices the next
// 24 entries from there. Falls back to the start of the array rather than
// throwing if "now" isn't found for some reason — a slightly-off hourly
// strip is far better than losing the whole weather card over it.
function buildHourlyNext24(data) {
  const times = data.hourly && data.hourly.time;
  if (!Array.isArray(times) || !times.length) return [];

  const nowIso = data.current && data.current.time;
  let startIdx = nowIso ? times.findIndex((t) => t >= nowIso) : 0;
  if (startIdx === -1) startIdx = 0;

  return times.slice(startIdx, startIdx + 24).map((time, offset) => {
    const i = startIdx + offset;
    const code = data.hourly.weather_code[i];
    const isDay = !!data.hourly.is_day[i];
    return {
      time,
      code,
      tempC: data.hourly.temperature_2m[i],
      rainChancePct: data.hourly.precipitation_probability[i],
      isDay,
      condition: describeWeatherCode(code),
      emoji: weatherEmoji(code, isDay),
    };
  });
}

// WMO weather codes -> plain English (Open-Meteo uses the WMO standard)
function describeWeatherCode(code) {
  const map = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
  };
  return map[code] || 'Unknown';
}

// Same WMO codes, mapped to a single representative emoji for the hero
// display. isDay swaps the couple of codes that look meaningfully
// different after dark (clear/partly-cloudy) — everything else (rain,
// snow, fog, thunder) reads the same regardless of time of day.
function weatherEmoji(code, isDay) {
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code === 1 || code === 2) return isDay ? '⛅' : '☁️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return '🌧️';
  if ([71, 73, 75].includes(code)) return '🌨️';
  if ([95, 96, 99].includes(code)) return '⛈️';
  return '🌡️';
}

module.exports = { getWeather };
