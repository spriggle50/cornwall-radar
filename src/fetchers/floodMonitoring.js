// River & sea levels + flood warnings — the Environment Agency's own Real
// Time flood-monitoring API (https://environment.data.gov.uk/flood-monitoring),
// part of the wider Defra Data Services Platform (environment.data.gov.uk/apiportal).
// Free, no API key, Open Government Licence. Two calls: current flood
// warnings/alerts for Cornwall, and the latest level reading from whichever
// monitoring stations are nearest the selected location.
const DEFAULT_LAT = 50.2632; // Truro, Cornwall
const DEFAULT_LON = -5.0510;

// Matches the EA's own text for each numeric severityLevel — confirmed
// against a real, live response while building this (two genuine Cornwall
// coastal flood alerts came back), so this mapping is solid.
const SEVERITY_LABELS = {
  1: 'Severe Flood Warning',
  2: 'Flood Warning',
  3: 'Flood Alert',
  4: 'Warning No Longer In Force',
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function getFloodAndRiverLevels({ lat = DEFAULT_LAT, lon = DEFAULT_LON } = {}) {
  const floodsUrl = 'https://environment.data.gov.uk/flood-monitoring/id/floods?county=Cornwall';
  const stationsUrl = `https://environment.data.gov.uk/flood-monitoring/id/stations?lat=${lat}&long=${lon}&dist=20&parameter=level&status=Active&_limit=8`;

  let warnings = [];
  let warningsError = null;
  try {
    const floodsData = await fetchJson(floodsUrl);
    warnings = (floodsData.items || []).map((f) => ({
      description: f.description || null,
      severity: f.severity || SEVERITY_LABELS[f.severityLevel] || 'Flood notice',
      severityLevel: f.severityLevel != null ? f.severityLevel : null,
      isTidal: !!f.isTidal,
      message: f.message || null,
      timeRaised: f.timeRaised || null,
      timeSeverityChanged: f.timeSeverityChanged || null,
    }));
    // Most severe (lowest number) first; "no longer in force" (4) last.
    warnings.sort((a, b) => (a.severityLevel || 99) - (b.severityLevel || 99));
  } catch (err) {
    warningsError = err.message;
  }

  let stations = [];
  let stationsError = null;
  try {
    const stationsData = await fetchJson(stationsUrl);
    const nearby = (stationsData.items || []).slice(0, 8);
    const readings = await Promise.allSettled(
      nearby.map((s) => fetchJson(`https://environment.data.gov.uk/flood-monitoring/id/stations/${encodeURIComponent(s.notation)}/readings?latest&_limit=1`))
    );
    stations = nearby.map((s, idx) => {
      const r = readings[idx];
      const reading = r.status === 'fulfilled' && r.value.items && r.value.items[0] ? r.value.items[0] : null;
      return {
        label: s.label || s.riverName || s.notation,
        riverName: s.riverName || null,
        town: s.town || null,
        lat: s.lat != null ? s.lat : null,
        lon: s.long != null ? s.long : null,
        isTidal: (s.type || []).some((t) => String(t).toLowerCase().includes('tidal')),
        latestValue: reading ? reading.value : null,
        latestDateTime: reading ? reading.dateTime : null,
        unitName: (s.measures && s.measures[0] && s.measures[0].unitName) || null,
      };
    });
  } catch (err) {
    stationsError = err.message;
  }

  if (warningsError && stationsError) {
    throw new Error(`Flood monitoring request failed: ${warningsError} / ${stationsError}`);
  }

  return {
    source: 'Environment Agency (Real Time flood-monitoring API)',
    warnings,
    warningsError,
    stations,
    stationsError,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getFloodAndRiverLevels };
