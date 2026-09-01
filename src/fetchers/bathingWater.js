// Bathing Water Quality — the Environment Agency's official beach water
// quality classifications and short-term pollution risk forecasts
// (environment.data.gov.uk/apiportal, "Bathing waters"). Free, no API key,
// Open Government Licence. Pairs naturally with the Storm Overflows page —
// a nearby discharge often means a raised pollution risk at the beach.
//
// This went through two versions. The first used `/doc/bathing-water.json`
// with a guessed `_properties` chain and came back "unavailable" in
// production — turns out `/doc/` isn't the right path prefix at all (it's
// also the one this API's own robots.txt disallows, which made it
// impossible to catch by testing from this project's own sandbox, since
// the research tooling here respects robots.txt on that exact prefix).
// The real listing endpoint — confirmed against the API's own live
// reference docs — is under `/id/`, matching the same convention the
// flood-monitoring API already uses successfully elsewhere in this
// project (`/id/floods`, `/id/stations`), and each site's coordinates live
// nested under `samplingPoint`, not flat `lat`/`long` as first assumed.
//
// The classification and short-term pollution-risk data live on two
// further endpoints this project hasn't been able to confirm the exact
// query shape for from this sandbox (same access restriction as above).
// Rather than guess a second time and risk silently breaking again, that
// enrichment is attempted as a best-effort bonus below — if it doesn't
// come back in the expected shape, sites still show with their name and
// location, just without a rating, instead of the whole section going
// "unavailable" over a part that was never confirmed working.
const LIST_URL = 'https://environment.data.gov.uk/id/bathing-water.json?_view=bathing-water&_pageSize=1000';
const IN_SEASON_URL = 'https://environment.data.gov.uk/doc/bathing-water-quality/in-season/latest.json?_view=assessment&_pageSize=1000';
const RISK_URL = 'https://environment.data.gov.uk/doc/bathing-water-quality/advice-against-bathing/situations.json?_view=situation-details&_pageSize=200';

const CORNWALL_BOUNDS = { minLat: 49.9, maxLat: 50.75, minLon: -5.75, maxLon: -4.2 };

function firstOf(obj, paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
    if (val != null) return val;
  }
  return null;
}

async function fetchJsonSafe(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function getBathingWaterQuality() {
  const res = await fetch(LIST_URL, {
    headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)', Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Bathing water request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const rawItems = data.items || data.result?.items || [];

  const sites = rawItems
    .map((item) => {
      const name = firstOf(item, ['name', 'label']);
      const lat = firstOf(item, ['samplingPoint.lat', 'lat', 'latitude']);
      const lon = firstOf(item, ['samplingPoint.long', 'long', 'lon', 'longitude']);
      const eubwid = firstOf(item, ['eubwidNotation', 'notation']);
      if (name == null || lat == null || lon == null) return null;
      return {
        name: String(name),
        eubwid: eubwid ? String(eubwid) : null,
        lat: Number(lat),
        lon: Number(lon),
        classification: null,
        riskLevel: null,
      };
    })
    .filter((s) => s
      && s.lat >= CORNWALL_BOUNDS.minLat && s.lat <= CORNWALL_BOUNDS.maxLat
      && s.lon >= CORNWALL_BOUNDS.minLon && s.lon <= CORNWALL_BOUNDS.maxLon);

  // Best-effort enrichment — see the file header. Neither of these calls
  // can fail the whole feature; a site simply keeps its null rating if a
  // match isn't found or either shape doesn't come back as expected.
  const [inSeasonData, riskData] = await Promise.all([fetchJsonSafe(IN_SEASON_URL), fetchJsonSafe(RISK_URL)]);

  const inSeasonItems = (inSeasonData && (inSeasonData.items || inSeasonData.result?.items)) || [];
  for (const assessment of inSeasonItems) {
    const eubwid = firstOf(assessment, ['bwq_bathingWater.eubwidNotation', 'bathingWater.eubwidNotation']);
    const classification = firstOf(assessment, ['sampleClassification.complianceCodeNotation', 'sampleClassification.label', 'sampleClassification']);
    if (!eubwid || !classification) continue;
    const site = sites.find((s) => s.eubwid === String(eubwid));
    if (site) site.classification = String(classification);
  }

  const riskItems = (riskData && (riskData.items || riskData.result?.items)) || [];
  for (const situation of riskItems) {
    const eubwid = firstOf(situation, ['bathingWater.eubwidNotation', 'bwq_bathingWater.eubwidNotation']);
    const riskLevel = firstOf(situation, ['riskLevel.label', 'riskLevel']);
    if (!eubwid || !riskLevel) continue;
    const site = sites.find((s) => s.eubwid === String(eubwid));
    if (site) site.riskLevel = String(riskLevel);
  }

  sites.sort((a, b) => a.name.localeCompare(b.name));

  return {
    source: 'Environment Agency (Bathing Water Quality)',
    sites,
    ratingsAvailable: sites.some((s) => s.classification),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getBathingWaterQuality };
