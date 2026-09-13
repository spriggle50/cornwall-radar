// A small in-memory TTL cache for the aggregated dashboard response.
//
// Before this, GET /api/dashboard had zero caching: every single page load
// re-ran all ~16 external API calls from scratch, even if the previous
// visitor had loaded the exact same location two seconds earlier. Combined
// with fetchWithTimeout.js (which bounds how long any one slow upstream can
// block the response), this cache is the other half of the fix for "the
// site is really really slow to load" — most requests now get served
// straight from memory instead of waiting on 16 live API calls.
//
// Deliberately simple: a plain in-memory Map, one process — matches how
// this actually runs today (a single Railway dyno, no Redis or other shared
// cache in place yet). If this ever runs as multiple instances, each would
// keep its own cache, which is still correct (just less effective), since
// it only ever serves data it fetched itself.
//
// In-flight de-duplication: if a second request for the same location comes
// in while the first one is still out fetching (two visitors load the page
// in the same second, or a cold cache right after deploy), the second
// request awaits the same in-progress fetch instead of kicking off its own
// duplicate round of ~16 API calls.

const TTL_MS = 90 * 1000; // 90 seconds — short enough that live-feeling data
// (bus times, traffic, tide state) never seems stale, long enough to absorb
// the realistic case of several visitors loading the same location within a
// couple of minutes of each other.

const store = new Map(); // key -> { expiresAt, data }
const inFlight = new Map(); // key -> Promise<data>

// Rounds to ~1.1km resolution so that, for example, 50.26320 and 50.26321
// (effectively the same spot, just floating-point noise from the client)
// share one cache entry instead of each triggering their own fetch round.
function cacheKey(lat, lon) {
  const rLat = Math.round(lat * 100) / 100;
  const rLon = Math.round(lon * 100) / 100;
  return `${rLat},${rLon}`;
}

// fetchFn is called at most once per key per TTL window (barring the
// in-flight race described above) — it should return a fresh dashboard
// payload, exactly as before this cache existed.
async function getOrFetch(lat, lon, fetchFn) {
  const key = cacheKey(lat, lon);

  const cached = store.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { data: cached.data, cacheHit: true };
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending.then((data) => ({ data, cacheHit: true }));
  }

  const promise = fetchFn()
    .then((data) => {
      store.set(key, { expiresAt: Date.now() + TTL_MS, data });
      return data;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  const data = await promise;
  return { data, cacheHit: false };
}

module.exports = { getOrFetch, TTL_MS };
