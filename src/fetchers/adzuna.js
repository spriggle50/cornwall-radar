// External jobs feed — Adzuna Jobs API (https://developer.adzuna.com/).
// Free developer registration, no card required. Runs alongside (never
// instead of) the business-posted vacancies in business_vacancies — this
// fetcher only ever ADDS more roles to the Local Jobs page, it never
// replaces the free, direct listings that are this site's own differentiator.
//
// Optional, same pattern as ticketmaster/nationalHighways/googleWeather in
// this project: with no key set, getExternalJobs() just reports
// `configured: false` and an empty list — the Local Jobs page still works
// fine with only business-posted vacancies.
//
// A short in-memory cache (its own, not dashboardCache.js — that one's keyed
// by lat/lon for the main dashboard, this is keyed by search term) keeps
// repeated searches for the same term from burning through Adzuna's free-tier
// call allowance every time someone opens the Local Jobs page.

const { fetchWithTimeout } = require('../lib/fetchWithTimeout');

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs/gb/search';

// Adzuna caps a single page at 50 results, with further pages fetched via
// separate requests to /search/2, /search/3, etc. — there's no single
// "give me 100" parameter. Cornwall-wide searches were coming back capped
// at the old 25-per-page limit even though more roles existed; fetching
// two pages at 50 each covers up to 100 without guessing at some larger
// single-page number that the API would just reject.
const RESULTS_PER_PAGE = 50;
const PAGES_TO_FETCH = 2;

const TTL_MS = 15 * 60 * 1000; // 15 minutes — job ads don't turn over fast
// enough to need anything shorter, and this is what keeps a busy day of
// visitors to one search term (or none) down to a handful of real Adzuna
// calls instead of one per page load.
const cache = new Map(); // key -> { expiresAt, jobs }

// Adzuna's own description field comes back as a full HTML-ish blob with the
// odd stray tag — stripped down to plain text and trimmed to a sensible
// preview length, same spirit as how a business's own vacancy description is
// just plain text to begin with.
function cleanDescription(raw) {
  if (!raw) return null;
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 260 ? text.slice(0, 257).trimEnd() + '…' : text;
}

async function getExternalJobs({ q } = {}) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    return {
      configured: false,
      message: 'ADZUNA_APP_ID/ADZUNA_APP_KEY not set — add them to .env for extra roles from around Cornwall (free registration at developer.adzuna.com).',
      jobs: [],
    };
  }

  const term = (q || '').trim().slice(0, 100);
  const cacheKey = term.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { configured: true, jobs: cached.jobs };
  }

  function buildUrl(page) {
    const params = new URLSearchParams({
      app_id: ADZUNA_APP_ID,
      app_key: ADZUNA_APP_KEY,
      where: 'Cornwall',
      results_per_page: String(RESULTS_PER_PAGE),
      sort_by: 'date',
      'content-type': 'application/json',
    });
    if (term) params.set('what', term);
    return `${ADZUNA_BASE_URL}/${page}?${params.toString()}`;
  }

  try {
    // Pages fetched in parallel and merged — a failure on one page (rate
    // limit, one slow request timing out) doesn't lose the other; only if
    // EVERY page fails does this actually throw and fall back to "no
    // external jobs this time" below.
    const pageResults = await Promise.allSettled(
      Array.from({ length: PAGES_TO_FETCH }, (_, i) => i + 1).map(async (page) => {
        const res = await fetchWithTimeout(buildUrl(page));
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Adzuna request failed: ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
        }
        return res.json();
      })
    );

    const fulfilled = pageResults.filter((r) => r.status === 'fulfilled');
    if (!fulfilled.length) {
      throw pageResults[0].reason || new Error('Adzuna request failed');
    }

    const seenIds = new Set();
    const jobs = [];
    for (const { value: data } of fulfilled) {
      for (const j of (data.results || [])) {
        // Prefixed so an id can never collide with a business_vacancies
        // uuid once the two lists are merged on the frontend/route.
        const id = 'adz-' + j.id;
        if (seenIds.has(id)) continue; // pages shouldn't overlap, but cheap to guard against it
        seenIds.add(id);
        jobs.push({
          id,
          title: j.title || 'Job vacancy',
          description: cleanDescription(j.description),
          applyUrl: j.redirect_url || null,
          companyName: j.company?.display_name || 'External listing',
          location: j.location?.display_name || null,
          createdAt: j.created || null,
          source: 'external',
        });
      }
    }

    cache.set(cacheKey, { expiresAt: Date.now() + TTL_MS, jobs });
    return { configured: true, jobs };
  } catch (err) {
    // Fail soft — the business-posted vacancies still render fine even if
    // Adzuna itself is down or rate-limited, same "don't take down the whole
    // page for one flaky source" approach as every other fetcher here.
    return { configured: true, jobs: [], error: err.message };
  }
}

module.exports = { getExternalJobs };
