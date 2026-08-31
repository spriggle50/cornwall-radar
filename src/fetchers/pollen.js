// Pollen fetcher — Google Pollen API (https://developers.google.com/maps/documentation/pollen)
// Requires a Google Cloud project with billing enabled and the Pollen API
// turned on — there is no card-free tier for this one, unlike every other
// source in this project. It's opt-in: GOOGLE_MAPS_API_KEY unset means this
// section just reports "not configured" and nothing else degrades.
//
// Response shape below (dailyInfo[].pollenTypeInfo[].indexInfo / plantInfo[])
// is per Google's documented Pollen API contract. Everything is read
// defensively (optional chaining, fallbacks) so a minor field-shape drift
// shows up as a missing stat rather than a crash.

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

async function getPollen(lat, lon) {
  if (!GOOGLE_MAPS_API_KEY) {
    return {
      source: 'Google Pollen API',
      configured: false,
      message: 'GOOGLE_MAPS_API_KEY is not set — add a billing-enabled Google Cloud API key to .env to turn on pollen forecasts.',
    };
  }

  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
    'location.latitude': String(lat),
    'location.longitude': String(lon),
    days: '3',
    languageCode: 'en',
  });
  const url = `https://pollen.googleapis.com/v1/forecast:lookup?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Google Pollen API request failed: ${res.status} ${res.statusText}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  const today = data.dailyInfo?.[0];

  const types = (today?.pollenTypeInfo || [])
    .filter((t) => t.indexInfo) // types with no index data yet aren't in season / not reported here
    .map((t) => ({
      code: t.code, // GRASS | TREE | WEED
      displayName: t.displayName || t.code,
      inSeason: !!t.inSeason,
      value: t.indexInfo.value != null ? t.indexInfo.value : null, // 0-5 Universal Pollen Index
      category: t.indexInfo.category || null, // e.g. "Low" / "Moderate" / "High" / "Very High"
      recommendation: (t.healthRecommendations || [])[0] || null,
    }));

  return {
    source: 'Google Pollen API',
    configured: true,
    date: today?.date ? `${today.date.year}-${String(today.date.month).padStart(2, '0')}-${String(today.date.day).padStart(2, '0')}` : null,
    types,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getPollen };
