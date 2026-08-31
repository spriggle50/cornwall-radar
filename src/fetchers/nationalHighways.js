// National Highways road closures — api.data.nationalhighways.co.uk
// NEEDS a free API key — register at https://developer.nationalhighways.co.uk/
// (the "Roads API" product) and set NATIONAL_HIGHWAYS_API_KEY.
//
// This covers planned/active closures on trunk roads (A30, A38, A39, A390
// through Cornwall) — a different, narrower data set than TomTom's incident
// feed, which is why traffic.js combines both rather than picking one.
//
// Several non-obvious things below are carried over from a separately-run
// project's own already-working integration with this same API (rewritten
// here as Cornwall Radar's own standalone copy — nothing imported or
// shared), each confirmed against the API's real behaviour rather than
// its docs, the hard way:
//   - Dates must be exactly YYYY-MM-DDThh:mm:ss — toISOString()'s
//     milliseconds + trailing "Z" get a 422 rejection.
//   - The API defaults to XML regardless of a normal Accept header; only
//     the X-Response-MediaType header actually switches it to JSON.
//   - A validation error can come back as HTTP 200 with the real error
//     status embedded in the JSON body instead of a 4xx/5xx.
//   - Data arrives in the DATEX II protocol — a deeply nested structure,
//     not the flat shape you'd guess at first glance.

const NATIONAL_HIGHWAYS_API_KEY = process.env.NATIONAL_HIGHWAYS_API_KEY;

// Road NUMBER alone isn't reliable — A30/A38 also run through other
// counties, so an incident hundreds of miles away could wrongly match on
// road name alone. A genuine coordinate check (Cornwall's bounding box) is
// tried first; the place-name list below is only a fallback for entries
// with no usable coordinates at all.
const CORNWALL_ROADS = ['A30', 'A38', 'A39', 'A390'];
const CORNWALL_PLACES = [
  'cornwall', 'plymouth', 'saltash', 'tamar', 'launceston', 'liskeard',
  'bodmin', 'truro', 'newquay', 'st austell', 'penzance', 'falmouth',
  'camborne', 'redruth', 'helston', 'fowey', 'padstow', 'wadebridge',
  'hayle', 'looe', 'callington', 'tavistock',
];

function formatDate(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

async function getRoadClosures() {
  if (!NATIONAL_HIGHWAYS_API_KEY) {
    return {
      source: 'National Highways',
      configured: false,
      message: 'NATIONAL_HIGHWAYS_API_KEY not set — register free at developer.nationalhighways.co.uk and add it to .env',
      closures: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  // Closures active from right now through the next 48 hours.
  const now = new Date();
  const in48hrs = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    startDateTime: formatDate(now),
    endDateTime: formatDate(in48hrs),
  });
  const url = `https://api.data.nationalhighways.co.uk/roads/v2.0/closures?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      'Ocp-Apim-Subscription-Key': NATIONAL_HIGHWAYS_API_KEY,
      'X-Response-MediaType': 'application/json',
      'Accept': 'application/json',
    },
  });
  const rawText = await res.text();

  if (!res.ok) {
    throw new Error(`National Highways request failed: ${res.status} ${res.statusText} — ${rawText.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    // Confirmed this can happen — an XML error page came back instead of
    // JSON at least once, despite the JSON-forcing headers above.
    throw new Error('National Highways returned an unexpected non-JSON response');
  }

  // A genuine HTTP 200 can still embed an error in the JSON body itself
  // (confirmed directly — a 422 validation error for a bad date format
  // came back as a 200), so response.ok alone isn't enough.
  if (typeof data.status === 'number' && data.status >= 400) {
    throw new Error(`National Highways error: ${data.error || data.status}`);
  }

  // DATEX II structure. Real path, confirmed from National Highways' own
  // Postman collection: D2Payload.situation[].situationRecord[]
  //   .sitRoadOrCarriagewayOrLaneManagement
  //     .generalPublicComment[0].comment  (description)
  //     .locationReference.locLocationGroupByList.locationContainedInGroup[]
  //       .locSingleRoadLinearLocation.linearWithinLinearElement[0]
  //         .linearElement.locLinearElementByCode.roadName
  //       .locLinearLocation.gmlLineString.locGmlLineString.posList
  //         (a flat "lat lon lat lon ..." sequence tracing the affected road)
  const situations = data.D2Payload?.situation || [];
  const allClosures = [];
  for (const s of situations) {
    for (const sr of s.situationRecord || []) {
      const slm = sr.sitRoadOrCarriagewayOrLaneManagement;
      if (!slm) continue;

      const description = slm.generalPublicComment?.[0]?.comment || '';
      const groups = slm.locationReference?.locLocationGroupByList?.locationContainedInGroup || [];

      for (const g of groups) {
        const road =
          g.locSingleRoadLinearLocation?.linearWithinLinearElement?.[0]?.linearElement
            ?.locLinearElementByCode?.roadName || '';
        const posList = g.locLinearLocation?.gmlLineString?.locGmlLineString?.posList || '';
        const nums = posList.trim().split(/\s+/).filter(Boolean).map(Number);

        // posList is a flat lat, lon, lat, lon, ... sequence for the whole
        // affected stretch — kept as the full line, not just its first
        // point, so the map can draw the real affected road rather than a
        // single dot.
        const linePoints = [];
        for (let i = 0; i + 1 < nums.length; i += 2) {
          linePoints.push([nums[i], nums[i + 1]]); // [lat, lon]
        }

        if (road || description) {
          allClosures.push({ road, description, linePoints });
        }
      }
    }
  }

  const closures = allClosures
    .filter((c) => {
      const onRelevantRoad = CORNWALL_ROADS.some((r) => c.road.includes(r));
      if (!onRelevantRoad) return false;

      if (c.linePoints.length) {
        const [lat, lon] = c.linePoints[0];
        const inCornwallBounds = lat >= 49.85 && lat <= 50.75 && lon >= -6.0 && lon <= -3.9;
        if (inCornwallBounds) return true;
      }
      const haystack = (c.description + ' ' + c.road).toLowerCase();
      return CORNWALL_PLACES.some((p) => haystack.includes(p));
    })
    .slice(0, 10)
    .map((c) => ({
      road: c.road || 'Unknown road',
      description: c.description || 'Closure reported',
      kind: 'closure',
      geometryType: c.linePoints.length > 1 ? 'LineString' : 'Point',
      // Normalised to [lon, lat] (...) — the same GeoJSON-style order
      // TomTom's incidents already use — so the map only needs to handle
      // one coordinate convention.
      coordinates:
        c.linePoints.length > 1
          ? c.linePoints.map(([lat, lon]) => [lon, lat])
          : c.linePoints[0]
          ? [c.linePoints[0][1], c.linePoints[0][0]]
          : null,
    }));

  return {
    source: 'National Highways',
    configured: true,
    closures,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getRoadClosures };
