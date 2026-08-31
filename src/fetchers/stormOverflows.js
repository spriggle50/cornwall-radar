// Storm overflow (sewage discharge) activity — South West Water's own
// near-real-time feed, published as a public ArcGIS feature layer as part
// of the water industry's National Storm Overflow Hub (launched November
// 2024, explicitly "open to the public and available for 3rd party use"
// per South West Water's own storm-overflow-data page). Free, no API key.
// Every outfall in Cornwall is on South West Water's network, so this one
// company's feed is all Cornwall Radar needs — no need to also merge in
// the other regional water companies' feeds.
//
// A note on the "status" field: South West Water's feed itself doesn't
// publish a plain-English data dictionary for it. Every water company's
// live map built on this same near-real-time hub only ever shows three
// states though (discharging / not discharging / offline-or-no-signal),
// and 0/1/2 is the value set actually seen on this feed, so that's the
// mapping used below — flagged here in case a future status code ever
// shows up that isn't one of those three, in which case treat it as
// unknown rather than assuming which of the three it is.
const FEATURE_SERVICE_URL = 'https://services-eu1.arcgis.com/OMdMOtfhATJPcHe3/arcgis/rest/services/NEH_outlets_PROD/FeatureServer/0/query';

// Same Cornwall bounding box used for wildlife sightings (wildlife.js) —
// South West Water's feed covers Devon and part of Dorset/Somerset too, so
// this is passed straight to the ArcGIS query itself (an envelope filter)
// rather than fetching the whole South West region and filtering after.
const CORNWALL_BOUNDS = { minLon: -5.75, minLat: 49.9, maxLon: -4.2, maxLat: 50.75 };

const STATUS_LABELS = {
  0: 'Not discharging',
  1: 'Discharging',
  2: 'Offline / no data',
};

async function getStormOverflows({ limit = 60 } = {}) {
  const url = new URL(FEATURE_SERVICE_URL);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', '*');
  url.searchParams.set('f', 'json');
  url.searchParams.set('geometry', `${CORNWALL_BOUNDS.minLon},${CORNWALL_BOUNDS.minLat},${CORNWALL_BOUNDS.maxLon},${CORNWALL_BOUNDS.maxLat}`);
  url.searchParams.set('geometryType', 'esriGeometryEnvelope');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('resultRecordCount', String(limit));

  const res = await fetch(url, {
    headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  });
  if (!res.ok) {
    throw new Error(`Storm overflow request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Storm overflow request failed: ${data.error.message || 'unknown ArcGIS error'}`);
  }

  const outfalls = (data.features || []).map((f) => {
    const a = f.attributes || {};
    return {
      id: a.Id || null,
      waterCourse: a.receivingWaterCourse || null,
      status: a.status,
      statusLabel: STATUS_LABELS[a.status] || 'Unknown status',
      statusStart: a.statusStart ? new Date(a.statusStart).toISOString() : null,
      latestEventStart: a.latestEventStart ? new Date(a.latestEventStart).toISOString() : null,
      latestEventEnd: a.latestEventEnd ? new Date(a.latestEventEnd).toISOString() : null,
      lastUpdated: a.lastUpdated ? new Date(a.lastUpdated).toISOString() : null,
      lat: a.latitude != null ? a.latitude : null,
      lon: a.longitude != null ? a.longitude : null,
    };
  });

  // Currently-discharging outfalls are the ones people actually want to
  // see first — the rest ordered by whichever changed status most recently.
  outfalls.sort((a, b) => {
    if (a.status === 1 && b.status !== 1) return -1;
    if (b.status === 1 && a.status !== 1) return 1;
    return (b.statusStart || '').localeCompare(a.statusStart || '');
  });

  return {
    source: 'South West Water (National Storm Overflow Hub)',
    outfalls,
    dischargingCount: outfalls.filter((o) => o.status === 1).length,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getStormOverflows };
