// "What's On" fetcher — Cornwall Live's dedicated entertainment/things-to-do
// RSS feed. Free, no API key required. This exact feed path was confirmed
// real and working by a separately-run project; adapted here as Cornwall
// Radar's own standalone fetcher rather than shared with it. Distinct from
// news.js's general hard-news feed — this one is curated for things to do
// (openings, festivals, days out), which is what belongs alongside ticketed
// events on an "Events & What's On" page.

const Parser = require('rss-parser');
const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  // Cornwall Live's feed carries a thumbnail per item via the standard
  // Media RSS namespace — rss-parser only exposes it if told to look,
  // hence the explicit customFields mapping below.
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});

const FEED_URL = 'https://www.cornwalllive.com/whats-on/?service=rss';

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

async function getWhatsOn({ limit = 8 } = {}) {
  const parsed = await parser.parseURL(FEED_URL);
  const items = (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    date: item.pubDate
      ? new Date(item.pubDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '',
    image: extractImage(item),
  }));

  return {
    source: "Cornwall Live What's On",
    items,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getWhatsOn };
