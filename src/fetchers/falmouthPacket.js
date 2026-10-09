// Shared helper for fetching one of Falmouth Packet's (Newsquest) RSS
// feeds. They publish separate, properly-categorised feeds per section —
// /news/rss/, /sport/rss/, /leisure/eventsguide/rss/, etc. — same idea as
// Cornwall Live's own /?service=rss, /sport/?service=rss, /whats-on/?service=rss.
//
// This file used to fetch ONE combined "everything just published" feed at
// /rss/ and guess each story's section from keywords, because that was the
// only Falmouth Packet feed URL known at the time. That combined feed has
// since stopped serving RSS at all — hitting it now just returns their
// normal website's HTML (scripts, cookie-consent banners, the lot) instead
// of a 404, which is what was actually breaking news.js/sport.js/whatson.js
// with confusing XML-parser errors ("Attribute without value" etc.) rather
// than a clean "feed not found". Pointing each caller at Newsquest's own
// correct per-section feed instead removes the guessing entirely.
//
// Still kept as one shared helper (rather than duplicated in news.js,
// sport.js and whatson.js) because Falmouth Packet's feeds — confirmed on
// more than one section — can contain a raw, un-escaped "&" that breaks
// strict XML parsing outright ("Invalid character in entity name").
// Fetching the raw text and sanitising it before parsing, once, here,
// covers every caller.
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

// Matches a bare "&" that ISN'T already the start of a valid XML entity
// (&amp; &lt; &gt; &quot; &apos; or a numeric &#123; / &#x7B;). See the file
// comment above — this is the fix for Falmouth Packet's "Invalid character
// in entity name" parse failures.
const UNESCAPED_AMPERSAND = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g;

function extractImage(item) {
  return item.mediaContent?.[0]?.$?.url || item.mediaThumbnail?.[0]?.$?.url || null;
}

// Fetches and parses ONE Falmouth Packet feed URL, returning items already
// shaped the same way every other source in this project's fetchers
// returns them (title/link/publishedAt/image/source) — so callers can drop
// the result straight into their own existing sort/round-robin logic with
// no extra mapping.
async function fetchFalmouthPacketFeed(url, limit) {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard)' },
  });
  if (!res.ok) {
    throw new Error(`Falmouth Packet request failed: ${res.status} ${res.statusText}`);
  }
  const rawXml = await res.text();
  // Sanitise before parsing, not after — by the time rss-parser would
  // throw, the feed hasn't been parsed at all, so there's no partial
  // result to patch up afterwards.
  const sanitisedXml = rawXml.replace(UNESCAPED_AMPERSAND, '&amp;');
  const parsed = await parser.parseString(sanitisedXml);

  return (parsed.items || []).slice(0, limit).map((item) => ({
    title: item.title || '',
    link: item.link || '',
    publishedAt: item.pubDate || item.isoDate || null,
    image: extractImage(item),
    source: 'Falmouth Packet',
  }));
}

module.exports = { fetchFalmouthPacketFeed };
