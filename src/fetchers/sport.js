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

  const items = [];
  const workingSources = [];
  const failedSources = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      workingSources.push(names[i]);
    } else {
      failedSources.push(names[i]);
      console.error(`[sport] ${names[i]} failed:`, result.reason && result.reason.message);
    }
  });

  if (!items.length) {
    throw new Error('All Cornwall sport sources failed: ' + failedSources.join(', '));
  }

  items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  return {
    source: workingSources.join(', '),
    items: items.slice(0, limit),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getSport };
