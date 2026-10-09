// Cornwall Sport fetcher — merges Cornwall Live's dedicated sport RSS feed
// with Falmouth Packet's own dedicated sport feed. Same fail-soft "one
// source down doesn't take the card down" approach as news.js — if either
// source is slow or down, the other still shows.
//
// Falmouth Packet's feed is fetched via the shared fetchFalmouthPacketFeed()
// helper (see fetchers/falmouthPacket.js) rather than this file's own
// parser.parseURL(), since its raw XML needs sanitising before parsing —
// that file's own comment explains why. This used to go through ONE
// combined Falmouth Packet feed and guess which stories were sport from
// keywords; that combined feed stopped serving RSS at all (silently
// falling through to their normal website's HTML instead), so this now
// points straight at their real, correctly categorised sport feed instead.

const Parser = require('rss-parser');
const { fetchFalmouthPacketFeed } = require('./falmouthPacket');

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

const FEED_URL = 'https://www.cornwalllive.com/sport/?service=rss';
const FALMOUTH_PACKET_SPORT_URL = 'https://www.falmouthpacket.co.uk/sport/rss/';

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

async function fetchCornwallLiveSport(limit) {
  const parsed = await parser.parseURL(FEED_URL);
  return (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    publishedAt: item.pubDate || item.isoDate || null,
    image: extractImage(item),
    source: 'Cornwall Live Sport',
  }));
}

async function getSport({ limit = 15 } = {}) {
  const names = ['Cornwall Live Sport', 'Falmouth Packet'];
  const settled = await Promise.allSettled([
    fetchCornwallLiveSport(limit),
    fetchFalmouthPacketFeed(FALMOUTH_PACKET_SPORT_URL, limit),
  ]);

  // Each successful source keeps its OWN array (sorted newest-first
  // internally) instead of being merged into one list and sorted by date —
  // same fix as news.js: a single global sort lets whichever source
  // publishes most often (Cornwall Live Sport, most likely) crowd out the
  // other almost entirely, even while both are being fetched successfully.
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
      console.error(`[sport] ${names[i]} failed:`, result.reason && result.reason.message);
    }
  });

  if (!bySource.length) {
    throw new Error('All Cornwall sport sources failed: ' + failedSources.join(', '));
  }

  // Round-robin across sources — one story from each in turn, most recent
  // first within each — instead of one global sort-by-date, so both
  // sources get a fair, even share of the final list.
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
    if (!addedAny) break;
  }

  return {
    source: workingSources.join(', '),
    items,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getSport };
