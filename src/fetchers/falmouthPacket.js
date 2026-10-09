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
const { fetchWithTimeout } = require('../lib/fetchWithTimeout');

const parser = new Parser({
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

// Matches a bare "&" that ISN'T already the start of a valid XML entity
// (&amp; &lt; &gt; &quot; &apos; or a numeric &#123; / &#x7B;). Falmouth
// Packet's own feed occasionally contains a raw, un-escaped "&" — e.g.
// "Fish & Chips" instead of "Fish &amp; Chips" — and rss-parser's
// underlying XML parser rejects the ENTIRE feed over that one character
// ("Invalid character in entity name") rather than tolerating it, which is
// what was silently dropping Falmouth Packet from news/sport/whatson every
// time their feed happened to contain one. Fetching the raw text ourselves
// and escaping any stray "&" before parsing fixes this at the source
// instead of hoping Newsquest's feed is always well-formed.
const UNESCAPED_AMPERSAND = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g;

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
  // Same call shape as tides.js/news.js/etc. use this shared helper with —
  // no explicit timeout override here, so it uses fetchWithTimeout's own
  // default rather than guessing at an option this file never passed
  // before (the old 8s figure was rss-parser's own internal fetch option,
  // which no longer applies now that it isn't doing the fetching).
  const res = await fetchWithTimeout(FEED_URL, {
    headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  });
  if (!res.ok) {
    throw new Error(`Falmouth Packet request failed: ${res.status} ${res.statusText}`);
  }
  const rawXml = await res.text();
  // Sanitise before parsing, not after — by the time rss-parser throws, the
  // feed hasn't been parsed at all, so there's no partial result to patch up.
  const sanitisedXml = rawXml.replace(UNESCAPED_AMPERSAND, '&amp;');
  const parsed = await parser.parseString(sanitisedXml);

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
