// Met Office National Severe Weather Warning Service (NSWWS) — the real
// official yellow/amber/red warnings (and the ones named storms like
// "Storm Bert" are issued under), via the Weather DataHub's NSWWS Public
// API v1.1. This is deliberately separate from fetchers/weather.js, which
// is just Open-Meteo's own forecast numbers and has no concept of an
// official warning at all — that gap (nothing on the dashboard flagged an
// incoming storm) is exactly what this fetcher exists to close.
//
// Free to use (20,000 requests/day), but needs its own registration —
// create a free account at https://datahub.metoffice.gov.uk, subscribe to
// the "Warnings" (NSWWS) product under Pricing & Plans, then copy the
// generated API key into METOFFICE_DATAHUB_API_KEY. Leave it blank and
// this just reports unconfigured — nothing else on the dashboard depends
// on it.
//
// Like every other fetcher in this project (see README's "Important"
// note), this is written correctly against the Met Office's own
// documented request/response shape (confirmed against their live API
// reference docs, including a real example response) but has not been
// proven against a live response with a real key — verify it once
// METOFFICE_DATAHUB_API_KEY is set, and adjust the area-matching logic
// below if "South West England" turns out not to be the exact regionName
// a real response uses.
const { fetchWithTimeout } = require('../lib/fetchWithTimeout');

const METOFFICE_DATAHUB_API_KEY = process.env.METOFFICE_DATAHUB_API_KEY;
const API_BASE = 'https://data.hub.api.metoffice.gov.uk/nswws/v1.1';

const isConfigured = () => !!METOFFICE_DATAHUB_API_KEY;

// Matches "South West England" (the Met Office's standard forecast region
// covering Cornwall, along with Devon, Dorset, Somerset etc. — NSWWS
// warnings aren't issued at a finer, per-county granularity than this).
// If a warning's affectedAreas also lists a subRegion mentioning Cornwall
// specifically, that's surfaced too, but isn't required for a match.
function coversCornwall(properties) {
  const areas = Array.isArray(properties.affectedAreas) ? properties.affectedAreas : [];
  return areas.some((a) => String(a.regionName || '').toLowerCase().includes('south west'));
}

// Finds the <link rel="related" ... href="..."> in the Atom feed — the
// Met Office's own docs say to always use this supplied URL rather than
// composing the /objects/issued/{uuid} path yourself. Attribute-order
// agnostic since Atom doesn't guarantee one.
function extractRelatedHref(atomXml) {
  const tags = atomXml.match(/<link\b[^>]*\/?>/g) || [];
  for (const tag of tags) {
    if (/\brel="related"/.test(tag)) {
      const hrefMatch = tag.match(/href="([^"]+)"/);
      if (hrefMatch) return hrefMatch[1];
    }
  }
  return null;
}

const LEVEL_RANK = { RED: 3, AMBER: 2, YELLOW: 1 };
const LEVEL_EMOJI = { RED: '🔴', AMBER: '🟠', YELLOW: '🟡' };

async function getWeatherWarnings() {
  if (!isConfigured()) {
    return { configured: false, message: 'METOFFICE_DATAHUB_API_KEY not set — add it to .env (datahub.metoffice.gov.uk)', warnings: [] };
  }

  const headers = { apikey: METOFFICE_DATAHUB_API_KEY };

  const feedRes = await fetchWithTimeout(`${API_BASE}/objects/feed`, {
    headers: { ...headers, accept: 'application/atom+xml' },
  });
  if (!feedRes.ok) {
    const body = await feedRes.text().catch(() => '');
    throw new Error(`Met Office NSWWS feed request failed: ${feedRes.status} ${feedRes.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }
  const feedXml = await feedRes.text();
  const snapshotUrl = extractRelatedHref(feedXml);
  if (!snapshotUrl) {
    // No "related" link in the feed is itself meaningful — the docs note
    // it's only present when there's something to point to — but err on
    // the side of surfacing nothing rather than guessing a URL.
    return { configured: true, warnings: [], fetchedAt: new Date().toISOString() };
  }

  const snapshotRes = await fetchWithTimeout(snapshotUrl, {
    headers: { ...headers, accept: 'application/geo+json' },
  });
  if (!snapshotRes.ok) {
    const body = await snapshotRes.text().catch(() => '');
    throw new Error(`Met Office NSWWS snapshot request failed: ${snapshotRes.status} ${snapshotRes.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }
  const geojson = await snapshotRes.json();
  const features = Array.isArray(geojson.features) ? geojson.features : [];

  const warnings = features
    .map((f) => f.properties || {})
    .filter(coversCornwall)
    .filter((p) => p.warningStatus === 'ISSUED')
    .map((p) => ({
      id: p.warningId,
      level: p.warningLevel,
      levelEmoji: LEVEL_EMOJI[p.warningLevel] || '⚠️',
      types: p.weatherType || [],
      headline: p.warningHeadline,
      whatToExpect: p.whatToExpect || [],
      validFrom: p.validFromDate,
      validTo: p.validToDate,
      issuedDate: p.issuedDate,
    }))
    .sort((a, b) => (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0));

  return { configured: true, warnings, fetchedAt: new Date().toISOString() };
}

module.exports = { getWeatherWarnings, isConfigured };
