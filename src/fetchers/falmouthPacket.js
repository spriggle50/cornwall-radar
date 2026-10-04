// Falmouth Packet (Newsquest) feed — fetched ONCE here and split into
// news/sport/what's-on buckets by each story's own RSS <category> tag,
// then shared out to news.js, sport.js and whatson.js. Unlike Cornwall
// Live, which already publishes three separate feeds
// (/?service=rss, /sport/?service=rss, /whats-on/?service=rss — each
// handled entirely within its own fetcher file, no splitting needed), the
// Falmouth Packet URL (https://www.falmouthpacket.co.uk/rss/) is one
// combined "everything just published" feed. Splitting it here, once,
// means the three dashboard cards actually fill with the right kind of
// story instead of every Falmouth Packet item — sport reports and what's-on
// listings included — landing in the News card next to Cornwall Live's and
// BBC's genuine news.
//
// Fetched at most once per TTL_MS regardless of how many of the three
// callers ask for it — news.js, sport.js and whatson.js are all triggered
// together from dashboard.js's own Promise.allSettled, so without this
// shared, short-lived cache the same Falmouth Packet feed URL would get hit
// three separate times on every single dashboard rebuild for no benefit.
const Parser = require('rss-parser');
const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});

const FEED_URL = 'https://www.falmouthpacket.co.uk/rss/';

// 10 minutes — this card only actually refreshes alongside the rest of the
// dashboard anyway (see dashboardCache.js's own TTL), so there's no benefit
// to fetching Falmouth Packet's feed more often than that; this just makes
// sure it's never fetched MORE often than needed within one dashboard
// rebuild either.
const TTL_MS = 10 * 60 * 1000;

// Matched against a story's title only when it has no <category> tag, or
// none of its tags map cleanly onto one of this dashboard's three cards.
// Deliberately conservative — anything not clearly sport or what's-on just
// stays in news, same "when in doubt, it's news" call a reader would make
// themselves. rss-parser exposes standard RSS <category> elements as
// item.categories (an array of strings) with no customFields mapping
// needed, so the tag check below is tried first and is the more reliable
// of the two.
const SPORT_KEYWORDS = /\b(fc|rugby|football|cricket|afc|match|fixture|league|cup final|athletics|rowing|surfing)\b/i;
const WHATSON_KEYWORDS = /\b(festival|gig|concert|exhibition|what'?s on|event|market|fete|fair|panto|theatre|cinema)\b/i;

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

function categoriseItem(item) {
  const tags = (item.categories || []).map((c) => String(c).toLowerCase());
  if (tags.some((t) => t.includes('sport'))) return 'sport';
  if (tags.some((t) => t.includes('what') || t.includes('leisure') || t.includes('entertainment'))) return 'whatson';

  const title = (item.title || '').toLowerCase();
  if (SPORT_KEYWORDS.test(title)) return 'sport';
  if (WHATSON_KEYWORDS.test(title)) return 'whatson';
  return 'news';
}

async function fetchAndCategorise() {
  const parsed = await parser.parseURL(FEED_URL);
  const buckets = { news: [], sport: [], whatson: [] };
  for (const item of (parsed.items || [])) {
    buckets[categoriseItem(item)].push({
      title: item.title || '',
      link: item.link || '',
      publishedAt: item.pubDate || item.isoDate || null,
      image: extractImage(item),
      source: 'Falmouth Packet',
    });
  }
  return buckets;
}

let cache = null; // { expiresAt, promise }

// Returns a promise for { news, sport, whatson }. The SAME in-flight (or
// just-resolved) promise is handed back to every caller within TTL_MS, so
// three near-simultaneous calls from news.js/sport.js/whatson.js cause only
// one real request to Newsquest's server.
function getFalmouthPacketByCategory() {
  if (cache && cache.expiresAt > Date.now()) return cache.promise;

  const promise = fetchAndCategorise().catch((err) => {
    // Don't cache a failure — the next call (maybe seconds later, from one
    // of the other two fetchers) should get a fresh attempt rather than
    // being stuck with a cached rejection for the rest of the TTL window.
    cache = null;
    throw err;
  });
  cache = { expiresAt: Date.now() + TTL_MS, promise };
  return promise;
}

module.exports = { getFalmouthPacketByCategory };
