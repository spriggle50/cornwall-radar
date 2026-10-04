// Cornwall Sport fetcher — merges Cornwall Live's dedicated sport RSS feed
// with the sport stories pulled out of Falmouth Packet's combined feed (see
// fetchers/falmouthPacket.js, which fetches that feed ONCE and shares it
// with news.js/whatson.js too, rather than three fetchers all hitting the
// same Falmouth Packet URL independently). Same fail-soft "one source down
// doesn't take the card down" approach as news.js — if either source is
// slow or down, the other still shows.

const Parser = require('rss-parser');
const { getFalmouthPacketByCategory } = require('./falmouthPacket');

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

async function fetchFalmouthPacketSport(limit) {
  const buckets = await getFalmouthPacketByCategory();
  return buckets.sport.slice(0, limit);
}

async function getSport({ limit = 15 } = {}) {
  const names = ['Cornwall Live Sport', 'Falmouth Packet'];
  const settled = await Promise.allSettled([
    fetchCornwallLiveSport(limit),
    fetchFalmouthPacketSport(limit),
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
