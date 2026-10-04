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
// SOURCES below is Cornwall Live, BBC and Rewind Radio — Falmouth Packet is
// deliberately NOT listed here: its one RSS feed covers news, sport AND
// what's-on together, so it's fetched and split by category ONCE in
// fetchers/falmouthPacket.js, and this file only takes that split's `news`
// bucket — see sport.js/whatson.js for the other two buckets of that same
// shared, cached fetch. Cornwall Live's and Rewind Radio's feed URLs have
// been confirmed live and working; BBC's regional feed uses their
// long-standing, well-documented URL pattern and Falmouth Packet's was
// supplied directly rather than guessed, but like every other fetcher in
// this project (see README's "Important" section), this sandbox has no
// outbound access to prove any of them live itself — run locally and check
// what actually comes back before relying on it.
const Parser = require('rss-parser');
const { getFalmouthPacketByCategory } = require('./falmouthPacket');

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  // Several Cornwall-area feeds (confirmed for Cornwall Live and Rewind
  // Radio; BBC's regional feeds commonly carry one too) include a
  // thumbnail via the standard Media RSS namespace — rss-parser only
  // exposes it if told to look, same fix already applied to whatson.js
  // and sport.js.
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
  // Confirmed live: a genuine RSS 2.0 feed (built on the aiir radio-station
  // CMS, nothing to do with this project) carrying Rewind Radio's own
  // Cornwall news stories, each with a media:content/media:thumbnail image.
  { name: 'Rewind Radio', url: 'https://www.rewindradio.co.uk/news/news/feed.xml' },
];

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

async function fetchSource(source, limit) {
  const parsed = await parser.parseURL(source.url);
  // Each source is asked for up to the full `limit` itself (not limit/N) —
  // so one outlet having a quiet news day doesn't starve the merged list of
  // stories the other outlets actually have plenty of; the round-robin
  // interleave below (not a plain slice) is what actually caps the total
  // shown and keeps the mix even across sources.
  return (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    publishedAt: item.pubDate || item.isoDate || null,
    image: extractImage(item),
    // Per-story attribution — lets the frontend tag each headline by outlet
    // (e.g. a small "via BBC News — Cornwall" badge), same idea as the
    // Local Jobs page's "via Adzuna" tag on an external listing.
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

  // Each successful source keeps its OWN array (sorted newest-first
  // internally) rather than being merged into one big list straight away —
  // a single global "merge everything then sort by date" badly favours
  // whichever outlet simply posts the most often (Cornwall Live, by a wide
  // margin), which was leaving BBC News and Falmouth Packet almost
  // invisible even though both were being fetched successfully every time.
  const bySource = [];
  const workingSources = [];
  const failedSources = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length) {
      const sorted = [...result.value].sort(
        (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)
      );
      bySource.push(sorted);
      workingSources.push(names[i]);
    } else if (result.status === 'rejected') {
      failedSources.push(names[i]);
      console.error(`[news] ${names[i]} failed:`, result.reason && result.reason.message);
    }
    // A fulfilled-but-empty source (e.g. a feed that's up but has nothing
    // new) isn't a failure — it's just not counted in workingSources,
    // same as it contributing zero items to a plain merge would be.
  });

  // Only if EVERY source failed (or none returned anything) does this
  // throw — dashboard.js's own Promise.allSettled wrapper then shows the
  // usual "Temporarily unavailable" card, same as a single-source failure
  // did before.
  if (!bySource.length) {
    throw new Error('All Cornwall news sources failed: ' + failedSources.join(', '));
  }

  // Round-robin across sources — one story from each in turn, most recent
  // first within each source — instead of one global sort-by-date. This
  // guarantees every working source gets a fair, even share of the final
  // list instead of being crowded out by whichever one simply publishes
  // most often. Within each "round" the order across sources follows
  // SOURCES' own order (then Falmouth Packet last), not strict recency —
  // a deliberate trade: evenness of mix over perfect minute-by-minute
  // freshness.
  const items = [];
  const pointers = new Array(bySource.length).fill(0);
  outer:
  while (items.length < limit) {
    let addedAny = false;
    for (let i = 0; i < bySource.length; i++) {
      if (pointers[i] < bySource[i].length) {
        items.push(bySource[i][pointers[i]]);
        pointers[i]++;
        addedAny = true;
        if (items.length >= limit) break outer;
      }
    }
    if (!addedAny) break; // every source's items exhausted before reaching limit
  }

  return {
    // A readable summary for anywhere still showing one "Source: X" line —
    // lists whichever sources actually came through this time, not a fixed
    // list, so a partial failure is reflected honestly rather than claiming
    // a source that didn't actually contribute anything this time round.
    source: workingSources.join(', '),
    items,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getNews };
