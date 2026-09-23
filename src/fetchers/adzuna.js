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
const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs/gb/search/1';

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

  try {
    const params = new URLSearchParams({
      app_id: ADZUNA_APP_ID,
      app_key: ADZUNA_APP_KEY,
      where: 'Cornwall',
      results_per_page: '25',
      sort_by: 'date',
      'content-type': 'application/json',
    });
    if (term) params.set('what', term);

    const res = await fetchWithTimeout(`${ADZUNA_BASE_URL}?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Adzuna request failed: ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
    }
    const data = await res.json();

    const jobs = (data.results || []).map((j) => ({
      // Prefixed so an id can never collide with a business_vacancies uuid
      // once the two lists are merged on the frontend/route.
      id: 'adz-' + j.id,
      title: j.title || 'Job vacancy',
      description: cleanDescription(j.description),
      applyUrl: j.redirect_url || null,
      companyName: j.company?.display_name || 'External listing',
      location: j.location?.display_name || null,
      createdAt: j.created || null,
      source: 'external',
    }));

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
