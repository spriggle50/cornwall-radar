// Cornwall Council News fetcher — the council's own official RSS feed.
// Free, no API key required — genuine UK local government content
// (implicitly OGL-licensed, same commercial-safe pattern as other UK gov
// sources used elsewhere in this project). Confirmed real and working at
// this exact path by a separately-run project.

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

const FEED_URL = 'https://www.cornwall.gov.uk/council-news/rss-feeds/newsfeed';

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

async function getCouncilNews({ limit = 15 } = {}) {
  const parsed = await parser.parseURL(FEED_URL);
  const items = (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    publishedAt: item.pubDate || item.isoDate || null,
    image: extractImage(item),
  }));

  return {
    source: 'Cornwall Council',
    items,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getCouncilNews };
