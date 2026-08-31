// Cornwall Sport fetcher — Cornwall Live's dedicated sport RSS feed. Free,
// no API key required, same publisher/terms as the general news feed
// (news.js), just scoped to their sport section. Confirmed real and
// working at this exact path by a separately-run project.

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

const FEED_URL = 'https://www.cornwalllive.com/sport/?service=rss';

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

async function getSport({ limit = 15 } = {}) {
  const parsed = await parser.parseURL(FEED_URL);
  const items = (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    publishedAt: item.pubDate || item.isoDate || null,
    image: extractImage(item),
  }));

  return {
    source: 'Cornwall Live Sport',
    items,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getSport };
