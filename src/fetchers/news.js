// Cornwall News fetcher — merges several independent Cornwall news RSS
// feeds instead of relying on one single outlet (Cornwall Live alone, this
// file's previous sole source). All free, no API key required.
//
// Each source is fetched in parallel and tolerated independently — same
// "one dead source shouldn't take the whole section down" approach as
// every other multi-source fetcher in this project (e.g. fetchers/events.js
// merging Ticketmaster across two search points). If one feed is slow or
// down, the others still come through rather than the news card going
// blank; only if EVERY source fails does this throw, same as before.
//
// SOURCES below is Cornwall Live and BBC only — both publish (or, for BBC,
// are assumed to publish) a dedicated general-news-only feed. Falmouth
// Packet is deliberately NOT listed here: its one RSS feed covers news,
// sport AND what's-on together, so it's fetched and split by category ONCE
// in fetchers/falmouthPacket.js, and this file only takes that split's
// `news` bucket — see sport.js/whatson.js for the other two buckets of that
// same shared, cached fetch. Only Cornwall Live's feed URL has actually
// been confirmed live and working by a separately-run project; BBC's
// regional feed uses their long-standing, well-documented URL pattern and
// Falmouth Packet's was supplied directly rather than guessed, but like
// every other fetcher in this project (see README's "Important" section),
// this sandbox has no outbound access to prove any of them live itself —
// run locally and check what actually comes back before relying on it.
const Parser = require('rss-parser');
const { getFalmouthPacketByCategory } = require('./falmouthPacket');

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  // Several Cornwall-area feeds (confirmed for Cornwall Live; BBC's regional
  // feeds commonly carry one too) include a thumbnail via the standard
  // Media RSS namespace — rss-parser only exposes it if told to look, same
  // fix already applied to whatson.js and sport.js.
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});

const SOURCES = [
  { name: 'Cornwall Live', url: 'https://www.cornwalllive.com/?service=rss' },
  { name: 'BBC News — Cornwall', url: 'https://feeds.bbci.co.uk/news/england/cornwall/rss.xml' },
];

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

async function fetchSource(source, limit) {
  const parsed = await parser.parseURL(source.url);
  // Each source is asked for up to the full `limit` itself (not limit/N) —
  // so one outlet having a quiet news day doesn't starve the merged list of
  // stories the other outlets actually have plenty of; the final slice
  // below is what actually caps the total shown.
  return (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    publishedAt: item.pubDate || item.isoDate || null,
    image: extractImage(item),
    // Per-story attribution — lets the frontend tag each headline by outlet
    // (e.g. a small "BBC News — Cornwall" badge), same idea as the Local
    // Jobs page's "via Adzuna" tag on an external listing.
    source: source.name,
  }));
}

async function fetchFalmouthPacketNews(limit) {
  const buckets = await getFalmouthPacketByCategory();
  return buckets.news.slice(0, limit);
}

async function getNews({ limit = 15 } = {}) {
  const names = [...SOURCES.map((s) => s.name), 'Falmouth Packet'];
  const settled = await Promise.allSettled([
    ...SOURCES.map((s) => fetchSource(s, limit)),
    fetchFalmouthPacketNews(limit),
  ]);

  const items = [];
  const workingSources = [];
  const failedSources = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      workingSources.push(names[i]);
    } else {
      failedSources.push(names[i]);
      console.error(`[news] ${names[i]} failed:`, result.reason && result.reason.message);
    }
  });

  // Only if EVERY source failed does this throw — dashboard.js's own
  // Promise.allSettled wrapper then shows the usual "Temporarily
  // unavailable" card, same as a single-source failure did before.
  if (!items.length) {
    throw new Error('All Cornwall news sources failed: ' + failedSources.join(', '));
  }

  items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  return {
    // A readable summary for anywhere still showing one "Source: X" line —
    // lists whichever sources actually came through this time, not a fixed
    // list, so a partial failure is reflected honestly rather than claiming
    // a source that didn't actually contribute anything this time round.
    source: workingSources.join(', '),
    items: items.slice(0, limit),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getNews };
