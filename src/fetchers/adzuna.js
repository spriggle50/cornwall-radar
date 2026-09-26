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
// by lat/lon for the main dashboard, this is keyed by search term AND page
// number) keeps repeated searches from burning through Adzuna's free-tier
// call allowance every time someone opens the Local Jobs page, or clicks
// "load more" on a page that's already been fetched by someone else recently.

const { fetchWithTimeout } = require('../lib/fetchWithTimeout');

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs/gb/search';

// Adzuna caps a single page at 50 results, with further pages fetched via
// separate requests to /search/2, /search/3, etc. — there's no single
// "give me everything" parameter. DEFAULT_PAGES is what a first, unfiltered
// visit to the Local Jobs page fetches (100 jobs); routes/directory.js can
// ask for more via its own `pages` argument once someone clicks "load more"
// there. MAX_PAGES is a hard ceiling so a "load more" button (or a stray
// crafted request) can't be used to fan this out into hundreds of calls —
// 10 pages is already 500 jobs, far more than the page would sensibly show.
const RESULTS_PER_PAGE = 50;
const DEFAULT_PAGES = 2;
const MAX_PAGES = 10;

const TTL_MS = 15 * 60 * 1000; // 15 minutes — job ads don't turn over fast
// enough to need anything shorter, and this is what keeps a busy day of
// visitors down to a handful of real Adzuna calls rather than one per page load.
const cache = new Map(); // "term|page" -> { expiresAt, jobs, isFullPage }

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

function buildUrl(term, page) {
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

// Fetches (or serves from cache) exactly one page of results — cached
// individually rather than as part of one big "pages 1 through N" blob, so
// asking for more pages later (a "load more" click going from 2 pages to 4)
// only ever fetches the two NEW pages, never re-requests the ones already
// held from a moment ago.
async function fetchPage(term, page) {
  const cacheKey = `${term.toLowerCase()}|${page}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const res = await fetchWithTimeout(buildUrl(term, page));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Adzuna request failed: ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  const results = data.results || [];
  const entry = {
    expiresAt: Date.now() + TTL_MS,
    jobs: results,
    // A page that came back full (a whole RESULTS_PER_PAGE's worth) means
    // there's likely at least one more page beyond it; a short or empty
    // page means this was the last one. Simpler and more robust than trying
    // to key off Adzuna's own total-count field, which isn't consistently
    // documented across their API versions.
    isFullPage: results.length === RESULTS_PER_PAGE,
  };
  cache.set(cacheKey, entry);
  return entry;
}

// `pages` — how many pages (from page 1) to fetch and merge this time.
// routes/directory.js passes a growing number as someone clicks "load more"
// on the Local Jobs page; left at its default for a first, unfiltered load.
async function getExternalJobs({ q, pages = DEFAULT_PAGES } = {}) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    return {
      configured: false,
      message: 'ADZUNA_APP_ID/ADZUNA_APP_KEY not set — add them to .env for extra roles from around Cornwall (free registration at developer.adzuna.com).',
      jobs: [],
      hasMore: false,
    };
  }

  const term = (q || '').trim().slice(0, 100);
  const pageCount = Math.min(Math.max(parseInt(pages, 10) || DEFAULT_PAGES, 1), MAX_PAGES);

  try {
    // Fetched in parallel and merged — a failure on one page (rate limit,
    // one slow request timing out) doesn't lose the others; only if EVERY
    // page fails does this actually throw and fall back to "no external
    // jobs this time" below.
    const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);
    const settled = await Promise.allSettled(pageNumbers.map((page) => fetchPage(term, page)));

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    if (!fulfilled.length) {
      throw settled[0].reason || new Error('Adzuna request failed');
    }

    const seenIds = new Set();
    const jobs = [];
    for (const { value } of fulfilled) {
      for (const j of value.jobs) {
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

    // "More to load" only if every page up to pageCount actually succeeded
    // AND the last of them came back full — a gap from a failed page in the
    // middle shouldn't offer to load page N+1 when page N itself is missing.
    const allSucceeded = fulfilled.length === pageNumbers.length;
    const lastPage = settled[settled.length - 1];
    const hasMore = pageCount < MAX_PAGES && allSucceeded && lastPage.status === 'fulfilled' && lastPage.value.isFullPage;

    return { configured: true, jobs, hasMore };
  } catch (err) {
    // Fail soft — the business-posted vacancies still render fine even if
    // Adzuna itself is down or rate-limited, same "don't take down the whole
    // page for one flaky source" approach as every other fetcher here.
    return { configured: true, jobs: [], hasMore: false, error: err.message };
  }
}

module.exports = { getExternalJobs };
