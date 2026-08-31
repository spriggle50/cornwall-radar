// Tide times fetcher — tidetimes.org.uk, free, no API key needed.
//
// RSS parsing logic below is adapted from a separately-run project's own
// already-working tide integration (rewritten here as Cornwall Radar's own
// standalone copy — nothing imported or shared). Two non-obvious things
// that project already had to work out the hard way, both carried over
// here rather than re-discovered by trial and error:
//   1. The feed packs an entire day's tides into ONE RSS item's
//      description as HTML lines ("01:18 - High Tide (5.00m)<br/>..."),
//      not one item per tide event.
//   2. That description arrives HTML-entity-encoded directly in the XML
//      (e.g. "&#x28;3.9m&#x29;" instead of a literal "(3.9m)"), so the
//      tide-line regex finds nothing until entities are decoded first.

const CORNWALL_TIDE_STATIONS = [
  { slug: 'falmouth', name: 'Falmouth', lat: 50.152, lon: -5.065 },
  { slug: 'newlyn', name: 'Newlyn', lat: 50.101, lon: -5.543 },
  { slug: 'st-ives-cornwall', name: 'St Ives', lat: 50.213, lon: -5.480 },
  { slug: 'padstow', name: 'Padstow', lat: 50.537, lon: -4.937 },
  { slug: 'fowey', name: 'Fowey', lat: 50.334, lon: -4.634 },
  { slug: 'looe', name: 'Looe', lat: 50.353, lon: -4.454 },
  { slug: 'newquay', name: 'Newquay', lat: 50.412, lon: -5.086 },
  { slug: 'mevagissey', name: 'Mevagissey', lat: 50.269, lon: -4.782 },
  { slug: 'penzance', name: 'Penzance', lat: 50.118, lon: -5.537 },
];

function nearestTideStation(lat, lon) {
  let nearest = CORNWALL_TIDE_STATIONS[0];
  let minDist = Infinity;
  for (const s of CORNWALL_TIDE_STATIONS) {
    const d = Math.sqrt((s.lat - lat) ** 2 + (s.lon - lon) ** 2);
    if (d < minDist) {
      minDist = d;
      nearest = s;
    }
  }
  return nearest;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

async function getTideTimes({ lat, lon } = {}) {
  const station = lat != null && lon != null ? nearestTideStation(lat, lon) : CORNWALL_TIDE_STATIONS[0];

  const rssUrl = `https://www.tidetimes.org.uk/${station.slug}-tide-times.rss`;
  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'CornwallRadar/0.1 (contact: set-your-contact-email-in-env)' },
  });
  if (!res.ok) {
    throw new Error(`tidetimes.org.uk request failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();

  const tides = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const item = itemMatch[1];
    const rawDesc =
      item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
      item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ||
      '';
    const desc = decodeEntities(rawDesc);

    const dateMatch = desc.match(/on (\d{1,2}(?:st|nd|rd|th)? \w+ \d{4})/);
    const itemDate = dateMatch ? dateMatch[1] : 'Today';

    const lineRegex = /(\d{1,2}:\d{2})\s*-\s*(High|Low) Tide\s*\((\d+\.\d+)m\)/gi;
    let lineMatch;
    while ((lineMatch = lineRegex.exec(desc)) !== null) {
      tides.push({
        time: lineMatch[1],
        type: lineMatch[2].charAt(0).toUpperCase() + lineMatch[2].slice(1).toLowerCase(),
        heightM: parseFloat(lineMatch[3]),
        date: itemDate,
      });
    }
  }

  if (tides.length === 0) {
    throw new Error('No tide events found in the tidetimes.org.uk feed');
  }

  return {
    source: 'tidetimes.org.uk',
    configured: true,
    station: station.name,
    tides: tides.slice(0, 8),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getTideTimes };
