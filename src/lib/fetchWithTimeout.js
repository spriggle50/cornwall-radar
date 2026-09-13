// A small wrapper around the global fetch() that enforces a hard timeout
// via AbortController. Added after a real production slowdown: most of
// this project's fetchers called fetch() directly with no timeout at all,
// so a single slow-to-respond (rather than cleanly erroring) upstream API
// could hang that one request for a very long time — and because the
// dashboard route waits for every fetcher via Promise.allSettled, one
// hanging call was enough to make the whole page feel "really really
// slow" to load, even when the other dozen-plus sources all came back
// quickly. Every fetcher's outbound request should go through this
// instead of calling fetch() directly, so no single source can ever hold
// up the page for more than a bounded, known time.
const DEFAULT_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${typeof url === 'string' ? url : url.toString()}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
