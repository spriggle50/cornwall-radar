// Bathing Water Quality — the Environment Agency's official beach water
// quality classifications and short-term pollution risk forecasts
// (environment.data.gov.uk/apiportal, "Bathing waters"). Free, no API key,
// Open Government Licence. Pairs naturally with the Storm Overflows page —
// a nearby discharge often means a raised pollution risk at the beach.
//
// This has now gone through three versions:
//  v1 used `/doc/bathing-water.json` with a guessed `_properties` chain —
//     came back "unavailable" (wrong property paths).
//  v2 switched to `/id/bathing-water.json`, reasoning (wrongly) that this
//     project's other Environment Agency fetcher (floodMonitoring.js) uses
//     an `/id/` path so this one should too. That other fetcher's real base
//     is `/flood-monitoring/id/floods` — a different API namespace
//     entirely — so the analogy didn't actually hold, and `/id/` started
//     returning a genuine 403 Forbidden in production.
//  v3 (this version) goes back to `/doc/`, this time confirmed against
//     FOUR independent, separately-versioned copies of the Environment
//     Agency's own bathing-water API reference (api-reference-v0.1,
//     v0.4, v0.6, and the plain-English help-api.html page for the public
//     "Swimfo" tool), which all consistently give the exact same literal
//     base URL: `http://environment.data.gov.uk/doc/bathing-water.json`.
//     None of them mention `/id/` as a usable collection endpoint at all —
//     the docs describe `/id/` as just the identifier for the resource
//     itself, with `/doc/` as the actual content-negotiated (HTML/JSON/
//     XML/CSV) endpoint. (This project's own sandbox can't fetch `/doc/`
//     directly to double-check — it's the one path this API's robots.txt
//     disallows, which blocks this project's own research tooling, not
//     real server-to-server requests like Railway's.)
//
// Two things are still not confirmed against a real live response (same
// sandbox restriction as above):
//  - Whether sites carry `samplingPoint.lat`/`samplingPoint.long` or only
//    `samplingPoint.easting`/`samplingPoint.northing` (British National
//    Grid). Real crawled example URLs for this exact API filter by
//    `samplingPoint.easting`, which suggests easting/northing might be the
//    only geometry actually populated — so both are requested, and grid
//    references are converted to lat/lon locally if that's what comes
//    back (see gridRefToLatLon below).
//  - The exact shape of `latestComplianceAssessment`/`latestRiskPrediction`
//    on each site record. There's no bulk endpoint for these across all
//    sites (confirmed absent from the API docs) — only a per-site
//    `_properties` lookup, e.g.
//    `/doc/bathing-water/{eubwid}.json?_properties=latestSampleAssessment.sampleClassification.label`.
//    That per-site lookup is only done for Cornwall's own ~20-25 sites
//    (after filtering the full England list down), and stays best-effort:
//    if it doesn't come back in the expected shape, a site just keeps a
//    null rating instead of the whole section failing.
const LIST_BASE = 'https://environment.data.gov.uk/doc/bathing-water.json';
const ITEM_BASE = 'https://environment.data.gov.uk/doc/bathing-water';
const PAGE_SIZE = 200; // the API's own documented maximum

const CORNWALL_BOUNDS = { minLat: 49.9, maxLat: 50.75, minLon: -5.75, maxLon: -4.2 };

const FETCH_HEADERS = { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)', Accept: 'application/json' };

function firstOf(obj, paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
    if (val != null) return val;
  }
  return null;
}

async function fetchJsonSafe(url) {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

// OS Great Britain National Grid (easting/northing, OSGB36) -> WGS84
// lat/lon. Standard published Ordnance Survey algorithm (Airy 1830
// ellipsoid + Helmert transform to WGS84) — accurate to within a few
// metres, which is more than enough for placing a map pin on a beach.
function gridRefToLatLon(easting, northing) {
  const a = 6377563.396, b = 6356256.909; // Airy 1830 semi-major/minor axes
  const F0 = 0.9996012717; // national grid scale factor on central meridian
  const lat0 = (49 * Math.PI) / 180, lon0 = (-2 * Math.PI) / 180; // true origin
  const N0 = -100000, E0 = 400000; // northing/easting of true origin, metres
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n, n3 = n * n * n;

  let lat = lat0, M = 0;
  do {
    lat = (northing - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (northing - N0 - M >= 0.00001);

  const sinLat = Math.sin(lat), cosLat = Math.cos(lat), tanLat = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;

  const tanLat2 = tanLat * tanLat, tanLat4 = tanLat2 * tanLat2, tanLat6 = tanLat4 * tanLat2;
  const secLat = 1 / cosLat;
  const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;

  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu3)) * (5 + 3 * tanLat2 + eta2 - 9 * tanLat2 * eta2);
  const IX = (tanLat / (720 * rho * nu5)) * (61 + 90 * tanLat2 + 45 * tanLat4);
  const X = secLat / nu;
  const XI = (secLat / (6 * nu3)) * (nu / rho + 2 * tanLat2);
  const XII = (secLat / (120 * nu5)) * (5 + 28 * tanLat2 + 24 * tanLat4);
  const XIIA = (secLat / (5040 * nu7)) * (61 + 662 * tanLat2 + 1320 * tanLat4 + 720 * tanLat6);

  const dE = easting - E0;
  const latRad = lat - VII * dE * dE + VIII * Math.pow(dE, 4) - IX * Math.pow(dE, 6);
  const lonRad = lon0 + X * dE - XI * Math.pow(dE, 3) + XII * Math.pow(dE, 5) - XIIA * Math.pow(dE, 7);

  // Helmert transform: OSGB36 -> WGS84 (Ordnance Survey's own published
  // seven-parameter values — small shift, ample precision for a map pin).
  const osgbLat = (latRad * 180) / Math.PI, osgbLon = (lonRad * 180) / Math.PI;
  return helmertOSGB36ToWGS84(osgbLat, osgbLon);
}

function helmertOSGB36ToWGS84(lat, lon) {
  const rad = Math.PI / 180;
  const a1 = 6377563.396, b1 = 6356256.909; // Airy 1830
  const e2 = 1 - (b1 * b1) / (a1 * a1);
  const phi = lat * rad, lambda = lon * rad;
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
  const nu = a1 / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const H = 0; // assume mean sea level — negligible effect on lat/lon output
  const x1 = (nu + H) * cosPhi * Math.cos(lambda);
  const y1 = (nu + H) * cosPhi * Math.sin(lambda);
  const z1 = ((1 - e2) * nu + H) * sinPhi;

  const tx = 446.448, ty = -125.157, tz = 542.060;
  const s = -20.4894 / 1e6;
  const rx = (0.1502 / 3600) * rad, ry = (0.2470 / 3600) * rad, rz = (0.8421 / 3600) * rad;

  const x2 = tx + x1 * (1 + s) - y1 * rz + z1 * ry;
  const y2 = ty + x1 * rz + y1 * (1 + s) - z1 * rx;
  const z2 = tz - x1 * ry + y1 * rx + z1 * (1 + s);

  const a2 = 6378137.0, b2 = 6356752.3141; // WGS84
  const e2b = 1 - (b2 * b2) / (a2 * a2);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let phi2 = Math.atan2(z2, p * (1 - e2b));
  for (let i = 0; i < 10; i++) {
    const nu2 = a2 / Math.sqrt(1 - e2b * Math.sin(phi2) * Math.sin(phi2));
    phi2 = Math.atan2(z2 + e2b * nu2 * Math.sin(phi2), p);
  }
  const lambda2 = Math.atan2(y2, x2);

  return { lat: (phi2 * 180) / Math.PI, lon: (lambda2 * 180) / Math.PI };
}

function extractCoords(item) {
  const lat = firstOf(item, ['samplingPoint.lat', 'lat', 'latitude']);
  const lon = firstOf(item, ['samplingPoint.long', 'long', 'lon', 'longitude']);
  if (lat != null && lon != null) return { lat: Number(lat), lon: Number(lon) };

  const easting = firstOf(item, ['samplingPoint.easting', 'easting']);
  const northing = firstOf(item, ['samplingPoint.northing', 'northing']);
  if (easting != null && northing != null) {
    try {
      return gridRefToLatLon(Number(easting), Number(northing));
    } catch (err) {
      return null;
    }
  }
  return null;
}

async function fetchAllSites() {
  const items = [];
  for (let page = 0; page < 3; page++) {
    const url = new URL(LIST_BASE);
    url.searchParams.set('_view', 'bathing-water');
    url.searchParams.set('_pageSize', String(PAGE_SIZE));
    url.searchParams.set('_page', String(page));

    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) {
      throw new Error(`Bathing water request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const pageItems = data.items || data.result?.items || [];
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) break; // last page
  }
  return items;
}

async function getBathingWaterQuality() {
  const rawItems = await fetchAllSites();

  const sites = rawItems
    .map((item) => {
      const name = firstOf(item, ['name', 'label']);
      const eubwid = firstOf(item, ['eubwidNotation', 'notation']);
      const coords = extractCoords(item);
      if (name == null || !coords) return null;
      return {
        name: String(name),
        eubwid: eubwid ? String(eubwid) : null,
        lat: coords.lat,
        lon: coords.lon,
        classification: null,
        riskLevel: null,
      };
    })
    .filter((s) => s
      && s.lat >= CORNWALL_BOUNDS.minLat && s.lat <= CORNWALL_BOUNDS.maxLat
      && s.lon >= CORNWALL_BOUNDS.minLon && s.lon <= CORNWALL_BOUNDS.maxLon);

  // Best-effort enrichment — see the file header. There's no bulk endpoint
  // for classification/risk, so this is one lookup per Cornwall site (not
  // per England site), and a failure on any of them just leaves that one
  // site with a null rating rather than affecting anything else.
  await Promise.all(sites.map(async (site) => {
    if (!site.eubwid) return;
    const url = new URL(`${ITEM_BASE}/${encodeURIComponent(site.eubwid)}.json`);
    url.searchParams.set('_properties', [
      'latestComplianceAssessment.sampleClassification.label',
      'latestSampleAssessment.sampleClassification.label',
      'latestRiskPrediction.riskLevel.label',
    ].join(','));
    const data = await fetchJsonSafe(url);
    if (!data) return;
    const item = data.items?.[0] || data.item || data;
    const classification = firstOf(item, [
      'latestComplianceAssessment.sampleClassification.label',
      'latestSampleAssessment.sampleClassification.label',
    ]);
    const riskLevel = firstOf(item, ['latestRiskPrediction.riskLevel.label']);
    if (classification) site.classification = String(classification);
    if (riskLevel) site.riskLevel = String(riskLevel);
  }));

  sites.sort((a, b) => a.name.localeCompare(b.name));

  return {
    source: 'Environment Agency (Bathing Water Quality)',
    sites,
    ratingsAvailable: sites.some((s) => s.classification),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getBathingWaterQuality };
