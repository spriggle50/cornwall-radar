// News / Sport / What's On fetcher — aggregates public RSS feeds.
// Swap/add feed URLs below for the exact sources Local Radar already uses;
// these are commonly-used Cornwall-relevant public feeds as a starting point.

const Parser = require('rss-parser');
const parser = new Parser({ timeout: 10000 });

const FEEDS = [
  { name: 'BBC News - Cornwall', category: 'news', url: 'https://feeds.bbci.co.uk/news/england/cornwall/rss.xml' },
  // Add/replace with the specific Cornwall Live / What's On RSS URLs Local Radar
  // already uses once confirmed — placeholders left out rather than guessed.
];

async function getNews({ limit = 15 } = {}) {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const parsed = await parser.parseURL(feed.url);
      return (parsed.items || []).map((item) => ({
        source: feed.name,
        category: feed.category,
        title: item.title,
        link: item.link,
        publishedAt: item.pubDate || item.isoDate || null,
        summary: item.contentSnippet || null,
      }));
    })
  );

  const items = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  const failed = results
    .map((r, i) => (r.status === 'rejected' ? { feed: FEEDS[i].name, error: r.reason.message } : null))
    .filter(Boolean);

  items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  return {
    source: 'RSS aggregate',
    items: items.slice(0, limit),
    failedFeeds: failed, // surface partial failures rather than silently dropping them
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getNews, FEEDS };
