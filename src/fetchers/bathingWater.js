// Bathing Water Quality — the Environment Agency's official beach water
// quality classifications and short-term pollution risk forecasts
// (environment.data.gov.uk/apiportal, "Bathing waters"). Free, no API key,
// Open Government Licence. Pairs naturally with the Storm Overflows page —
// a nearby discharge often means a raised pollution risk at the beach.
//
// Caveat worth knowing: this is a Linked Data API (Elda-style, the same
// framework family as the flood-monitoring API) that returns whatever
// property chain you ask for via `_properties`, and its dev environment
// couldn't be queried live while building this (this project's network
// egress and its research tooling both treat environment.data.gov.uk like
// the ArcGIS storm overflow feed — blocked in the sandbox this was built
// in, fine from a real server). The request/parameter shape below is built
// from the API's own published usage docs rather than a live test
// response, so the field-extraction below deliberately tries a few
// plausible shapes per value and quietly drops a site rather than crashing
// if none of them match — if classifications/risk levels come back empty
// once this is actually deployed, that's the first place to check.
const LIST_URL = 'https://environment.data.gov.uk/doc/bathing-water.json'
  + '?_view=basic&_pageSize=500'
  + '&_properties=lat,long,name,latestSampleAssessment.sampleClassification.label,latestRiskPrediction.riskLevel.label';

const CORNWALL_BOUNDS = { minLat: 49.9, maxLat: 50.75, minLon: -5.75, maxLon: -4.2 };

function firstOf(obj, paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
    if (val != null) return val;
  }
  return null;
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
      const lat = firstOf(item, ['lat', 'latitude']);
      const lon = firstOf(item, ['long', 'lon', 'longitude']);
      if (name == null || lat == null || lon == null) return null;
      const classification = firstOf(item, [
        'latestSampleAssessment.sampleClassification.label',
        'latestSampleAssessment.sampleClassification',
      ]);
      const riskLevel = firstOf(item, [
        'latestRiskPrediction.riskLevel.label',
        'latestRiskPrediction.riskLevel',
      ]);
      return {
        name: String(name),
        lat: Number(lat),
        lon: Number(lon),
        classification: classification ? String(classification) : null,
        riskLevel: riskLevel ? String(riskLevel) : null,
      };
    })
    .filter((s) => s
      && s.lat >= CORNWALL_BOUNDS.minLat && s.lat <= CORNWALL_BOUNDS.maxLat
      && s.lon >= CORNWALL_BOUNDS.minLon && s.lon <= CORNWALL_BOUNDS.maxLon);

  sites.sort((a, b) => a.name.localeCompare(b.name));

  return {
    source: 'Environment Agency (Bathing Water Quality)',
    sites,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getBathingWaterQuality };
