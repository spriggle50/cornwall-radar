// "What's On" fetcher — merges Cornwall Live's dedicated entertainment/
// things-to-do RSS feed with the what's-on stories pulled out of Falmouth
// Packet's combined feed (see fetchers/falmouthPacket.js, which fetches
// that feed ONCE and shares it with news.js/sport.js too, rather than three
// fetchers all hitting the same Falmouth Packet URL independently). Same
// fail-soft "one source down doesn't take the card down" approach as
// news.js/sport.js. Distinct from news.js's general hard-news sources —
// this card is curated for things to do (openings, festivals, days out),
// which is what belongs alongside ticketed events on an "Events & What's
// On" page.

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

const FEED_URL = 'https://www.cornwalllive.com/whats-on/?service=rss';

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

function formatDate(pubDate) {
  return pubDate
    ? new Date(pubDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '';
}

async function fetchCornwallLiveWhatsOn(limit) {
  const parsed = await parser.parseURL(FEED_URL);
  return (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    _pubDate: item.pubDate || item.isoDate || null, // kept only for sorting below, stripped before returning
    date: formatDate(item.pubDate),
    image: extractImage(item),
    source: "Cornwall Live What's On",
  }));
}

async function fetchFalmouthPacketWhatsOn(limit) {
  const buckets = await getFalmouthPacketByCategory();
  return buckets.whatson.slice(0, limit).map((item) => ({
    title: item.title,
    link: item.link,
    _pubDate: item.publishedAt,
    date: formatDate(item.publishedAt),
    image: item.image,
    source: item.source,
  }));
}

async function getWhatsOn({ limit = 8 } = {}) {
  const names = ["Cornwall Live What's On", 'Falmouth Packet'];
  const settled = await Promise.allSettled([
    fetchCornwallLiveWhatsOn(limit),
    fetchFalmouthPacketWhatsOn(limit),
  ]);

  // Same fix as news.js/sport.js: keep each source's own items (sorted
  // newest-first by _pubDate) instead of merging everything into one list
  // and sorting by date — a single global sort lets whichever source
  // publishes most often crowd out the other almost entirely.
  const bySource = [];
  const workingSources = [];
  const failedSources = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length) {
      const sorted = [...result.value].sort(
        (a, b) => new Date(b._pubDate || 0) - new Date(a._pubDate || 0)
      );
      bySource.push(sorted);
      workingSources.push(names[i]);
    } else if (result.status === 'rejected') {
      failedSources.push(names[i]);
      console.error(`[whatson] ${names[i]} failed:`, result.reason && result.reason.message);
    }
  });

  if (!bySource.length) {
    throw new Error("All Cornwall what's-on sources failed: " + failedSources.join(', '));
  }

  // Round-robin across sources — one item from each in turn, most recent
  // first within each — instead of one global sort-by-date.
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

  // _pubDate was only ever needed to sort Cornwall Live's and Falmouth
  // Packet's items against each other on equal footing — it's not part of
  // the shape this card's frontend already expects (just `date`, the
  // formatted display string), so it's dropped here rather than leaking a
  // new, undocumented field into the response.
  const cleaned = items.map(({ _pubDate, ...rest }) => rest);

  return {
    source: workingSources.join(', '),
    items: cleaned,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getWhatsOn };
