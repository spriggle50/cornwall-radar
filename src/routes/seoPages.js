// Server-rendered, JavaScript-free SEO pages for the business directory —
// a "Cornwall business directory" search should land on a page Google can
// read and index straight from the HTML response, not on the main app
// (public/index.html), which is a single-page app that loads all its real
// content in via JavaScript after the page loads and has no page/URL of its
// own for the directory at all. These pages are a second, much simpler
// front door onto the exact same `businesses` table — no accounts, no
// client-side JS required to see a listing, just plain HTML with real text,
// real <a> links, and its own <title>/description per page.
//
// Three page types, each targeting a different kind of search:
//  - GET /directory                    — the whole directory, grouped by
//    category. Targets the broad "Cornwall business directory" search.
//  - GET /directory?category=X         — one category across all of
//    Cornwall. Targets "<trade> in Cornwall"-style searches.
//  - GET /directory/business/:id/:slug — one business's own page. Targets
//    someone searching that business's name, or a longer-tail "<trade> in
//    <town>" search that the category page alone can't capture as
//    precisely. Every listed business gets one of these, free — this is
//    deliberately the same "index everything" approach as competing
//    directories that give every listing its own URL (e.g. Rewind Radio's
//    /directory/business/<name>/), which is what actually gives a directory
//    enough indexed pages to compete on long-tail searches.
//  - GET /sitemap.xml                  — lists all of the above so search
//    engines find them without needing to crawl-discover every link first.
const express = require('express');
const router = express.Router();
const { supabaseAdmin, isConfigured: supabaseConfigured } = require('../lib/supabaseClient');
const { BUSINESS_CATEGORIES } = require('../lib/businessCategories');

// www, not the bare domain — cornwallradar.co.uk (no www) only has a 301
// forward to this address (a CNAME, which is what Railway needs, can never
// sit at a bare domain's root — see index.html's own head-tag comment for
// the full story). Every canonical/og/sitemap URL these pages emit needs to
// be the address that actually resolves, or Google can end up treating the
// forwarding bare domain and this one as separate, competing pages.
const SITE_URL = 'https://www.cornwallradar.co.uk';

const escHtml = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Turns a business name into a readable URL segment — purely cosmetic/SEO
// (the actual lookup in GET /directory/business/:id/:slug uses :id alone),
// so this never needs to worry about uniqueness or a stale slug breaking a
// link: an old slug still resolves, this function just regenerates the
// current, correct one for the canonical tag and every link this file emits.
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'listing';
}

function businessPath(b) {
  return `/directory/business/${b.id}/${slugify(b.name)}`;
}

function categoryPath(category) {
  return category ? `/directory?category=${encodeURIComponent(category)}` : '/directory';
}

// One shared HTML skeleton for every page in this file — branded to match
// Cornwall Radar, but wholly self-contained (its own inline stylesheet,
// nothing loaded from index.html's own giant embedded one) since these
// pages are meant to render fully and instantly with zero JavaScript,
// unlike the main app.
function pageShell({ title, description, canonicalPath, jsonLd, bodyHtml, ogImage }) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;
  // A business's own page shares ITS logo (see the business-page route
  // below), so pasting that link into Facebook/WhatsApp/etc. previews the
  // actual business, not the generic Cornwall Radar icon every other page
  // here falls back to.
  const imageUrl = ogImage || `${SITE_URL}/brand/icon-512.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}" />
<link rel="canonical" href="${canonicalUrl}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${escHtml(title)}" />
<meta property="og:description" content="${escHtml(description)}" />
<meta property="og:url" content="${canonicalUrl}" />
<meta property="og:image" content="${imageUrl}" />
<meta name="twitter:card" content="summary" />
<link rel="icon" href="/brand/icon-96.png" />
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
<style>
  :root { --accent:#0a8f63; --accent-dark:#07734f; --text:#12181a; --text-2:#4b5a58; --text-3:#7c8b89; --border:#e4e9e7; --bg:#f6f8f7; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); line-height:1.5; }
  a { color:var(--accent-dark); }
  header.site-header { background:var(--text); color:#fff; padding:14px 20px; display:flex; align-items:center; gap:10px; }
  header.site-header img { width:32px; height:32px; }
  header.site-header a { color:#fff; text-decoration:none; font-weight:700; font-size:1.1rem; display:flex; align-items:center; gap:10px; }
  main { max-width:900px; margin:0 auto; padding:24px 20px 60px; }
  h1 { font-size:1.6rem; margin-bottom:6px; }
  h2 { font-size:1.15rem; margin:28px 0 10px; border-bottom:1px solid var(--border); padding-bottom:6px; }
  .lede { color:var(--text-2); max-width:680px; }
  .cta-box { background:#fff; border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin:18px 0 28px; }
  .cta-box a.btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; font-weight:700; padding:9px 16px; border-radius:8px; margin-top:8px; }
  .cat-nav { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 24px; padding:0; list-style:none; }
  .cat-nav a { display:inline-block; font-size:0.82rem; background:#fff; border:1px solid var(--border); border-radius:999px; padding:5px 12px; text-decoration:none; color:var(--text-2); }
  .cat-nav a.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .listing { background:#fff; border:1px solid var(--border); border-radius:10px; padding:14px 16px; margin-bottom:10px; display:flex; gap:12px; align-items:flex-start; }
  .listing-logo { width:44px; height:44px; border-radius:8px; object-fit:cover; flex-shrink:0; border:1px solid var(--border); background:#fff; }
  .listing-body { min-width:0; flex:1; }
  .listing h3 { margin:0 0 2px; font-size:1.02rem; }
  .listing h3 a { color:var(--text); text-decoration:none; }
  .listing .meta { color:var(--text-3); font-size:0.8rem; margin-bottom:6px; }
  .listing p { margin:6px 0; color:var(--text-2); font-size:0.92rem; }
  .featured-tag { display:inline-block; font-size:0.62rem; font-weight:800; text-transform:uppercase; background:#fff2cc; color:#9a6b00; padding:2px 8px; border-radius:999px; margin-left:6px; vertical-align:middle; }
  .btn-line a { display:inline-block; margin:10px 10px 0 0; font-weight:600; }
  .biz-header { display:flex; gap:16px; align-items:center; margin-bottom:4px; }
  .biz-logo { width:72px; height:72px; border-radius:12px; object-fit:cover; flex-shrink:0; border:1px solid var(--border); background:#fff; }
  footer.site-footer { text-align:center; color:var(--text-3); font-size:0.8rem; padding:24px 20px 40px; }
  footer.site-footer a { color:var(--text-3); }
  .breadcrumbs { font-size:0.8rem; color:var(--text-3); margin-bottom:14px; }
  .breadcrumbs a { color:var(--text-3); }
</style>
</head>
<body>
<header class="site-header"><a href="/"><img src="/brand/icon-96.png" alt="" /> Cornwall Radar</a></header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <p>Cornwall Radar — live weather, tides, traffic and a free business directory for Cornwall.</p>
  <p><a href="/">Back to the live dashboard</a> · <a href="/directory">Full business directory</a></p>
</footer>
</body>
</html>`;
}

// The same "list your business free" pitch appears on every page in this
// file — a category page and a single business's own page are both
// reasonable places for a visiting business owner (not just a consumer
// searching for one) to land, so the CTA to list is never more than one
// page away. Links to `/?listBusiness=1`, which index.html's own boot-time
// query-param check (see its `params.get('listBusiness')`) turns into
// automatically opening the sign-in/listing panel in the main app — these
// static pages have no JS of their own to call that function directly.
const LIST_BUSINESS_CTA = `
  <div class="cta-box">
    <strong>Own a business in Cornwall?</strong>
    <p style="margin:6px 0 0; color:var(--text-2);">List it on Cornwall Radar for free — visible to everyone browsing this directory, with the option to upgrade to a Featured listing later.</p>
    <a class="btn" href="/?listBusiness=1">List your business free →</a>
  </div>`;

function categoryNav(activeCategory) {
  const items = [`<li><a href="/directory"${activeCategory ? '' : ' class="active"'}>All categories</a></li>`]
    .concat(BUSINESS_CATEGORIES.map((c) => `<li><a href="${categoryPath(c)}"${c === activeCategory ? ' class="active"' : ''}>${escHtml(c)}</a></li>`));
  return `<ul class="cat-nav">${items.join('')}</ul>`;
}

function renderListingHtml(b) {
  const featuredTag = b.subscription_status === 'active' ? '<span class="featured-tag">★ Featured</span>' : '';
  // A plain grey square instead of an <img> at all when there's no logo —
  // no broken-image icon, and it keeps every row the same height whether or
  // not that business has uploaded one.
  const logo = b.logo_url
    ? `<img class="listing-logo" src="${escHtml(b.logo_url)}" alt="" loading="lazy" />`
    : `<div class="listing-logo" aria-hidden="true"></div>`;
  return `<div class="listing">
    ${logo}
    <div class="listing-body">
      <h3><a href="${businessPath(b)}">${escHtml(b.name)}</a>${featuredTag}</h3>
      <div class="meta">${escHtml(b.category)}${b.postcode ? ' · ' + escHtml(b.postcode) : ''}</div>
      ${b.description ? `<p>${escHtml(b.description)}</p>` : ''}
    </div>
  </div>`;
}

// GET /directory — the whole directory (no auth, no JS needed to read it).
// ?category=X narrows it to one category, same fixed list as everywhere
// else in this project (lib/businessCategories.js) so an invalid/typo'd
// value just falls back to showing everything rather than erroring.
router.get('/directory', async (req, res) => {
  const category = BUSINESS_CATEGORIES.includes(req.query.category) ? req.query.category : null;

  if (!supabaseConfigured()) {
    return res.send(pageShell({
      title: 'Cornwall Business Directory | Cornwall Radar',
      description: 'A free directory of local businesses across Cornwall.',
      canonicalPath: categoryPath(category),
      bodyHtml: '<h1>Cornwall Business Directory</h1><p class="lede">The directory isn\'t set up on this server yet.</p>',
    }));
  }

  try {
    let query = supabaseAdmin
      .from('businesses')
      .select('id, name, category, description, postcode, logo_url, subscription_status');
    if (category) query = query.eq('category', category);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const businesses = data || [];
    businesses.sort((a, b) => {
      if ((a.subscription_status === 'active') !== (b.subscription_status === 'active')) {
        return a.subscription_status === 'active' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const title = category
      ? `${category} in Cornwall — Free Business Directory | Cornwall Radar`
      : 'Cornwall Business Directory — Free Local Business Listings | Cornwall Radar';
    const description = category
      ? `${category} businesses across Cornwall, listed free on Cornwall Radar's local business directory. Browse listings or add your own for free.`
      : `Browse ${businesses.length || 'hundreds of'} local businesses across Cornwall for free — every category from trades to cafes, days out to professional services. List your own business free.`;

    let body = `<h1>${category ? escHtml(category) + ' in Cornwall' : 'Cornwall Business Directory'}</h1>`;
    body += `<p class="lede">${category
      ? `Every ${escHtml(category)} business listed free on Cornwall Radar's Cornwall business directory, in one place.`
      : `A free, growing directory of local businesses across Cornwall — from trades and cafes to days out and professional services. No charge to list, ever.`}</p>`;
    body += LIST_BUSINESS_CTA;
    body += categoryNav(category);

    if (!businesses.length) {
      body += `<p class="lede">No businesses listed${category ? ' in this category' : ''} yet — be the first.</p>`;
    } else if (category) {
      body += businesses.map(renderListingHtml).join('');
    } else {
      // Grouped by category on the all-directory view, same grouping the
      // in-app directory's own filter dropdown offers, so the page reads as
      // a real directory (with real internal links into each category) and
      // not just one long undifferentiated list.
      const byCategory = {};
      for (const b of businesses) {
        (byCategory[b.category] = byCategory[b.category] || []).push(b);
      }
      for (const c of BUSINESS_CATEGORIES) {
        if (!byCategory[c] || !byCategory[c].length) continue;
        body += `<h2 id="${slugify(c)}">${escHtml(c)}</h2>`;
        body += byCategory[c].map(renderListingHtml).join('');
      }
    }

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: title,
      itemListElement: businesses.slice(0, 100).map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${SITE_URL}${businessPath(b)}`,
        name: b.name,
      })),
    };

    res.set('Cache-Control', 'public, max-age=300');
    res.send(pageShell({ title, description, canonicalPath: categoryPath(category), jsonLd, bodyHtml: body }));
  } catch (err) {
    console.error('[seoPages] /directory failed:', err.message);
    res.status(500).send(pageShell({
      title: 'Cornwall Business Directory | Cornwall Radar',
      description: 'A free directory of local businesses across Cornwall.',
      canonicalPath: '/directory',
      bodyHtml: '<h1>Cornwall Business Directory</h1><p class="lede">Temporarily unavailable — please try again shortly.</p>',
    }));
  }
});

// GET /directory/business/:id/:slug — one business's own page. :slug is
// cosmetic only (see slugify's own comment) — only :id is used to look the
// listing up, so an old link with a stale slug (the owner renamed since)
// still resolves correctly; the canonical tag always reflects the current,
// correct slug regardless of what was requested.
router.get('/directory/business/:id/:slug?', async (req, res) => {
  if (!supabaseConfigured()) return res.status(404).send(pageShell({
    title: 'Listing not found | Cornwall Radar',
    description: 'This listing could not be found.',
    canonicalPath: '/directory',
    bodyHtml: '<h1>Not found</h1><p class="lede">The directory isn\'t set up on this server yet.</p>',
  }));

  try {
    const { data: b, error } = await supabaseAdmin
      .from('businesses')
      .select('id, name, category, description, phone, website, postcode, logo_url, subscription_status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (!b) {
      return res.status(404).send(pageShell({
        title: 'Listing not found | Cornwall Radar',
        description: 'This business listing could not be found — it may have been removed.',
        canonicalPath: '/directory',
        bodyHtml: '<h1>Listing not found</h1><p class="lede">This business listing could not be found — it may have been removed. <a href="/directory">Browse the full directory →</a></p>',
      }));
    }

    const title = `${b.name} — ${b.category} in Cornwall | Cornwall Radar`;
    const description = b.description
      ? `${b.name}: ${b.description}`.slice(0, 300)
      : `${b.name}, a ${b.category} business in Cornwall, listed free on Cornwall Radar's business directory.`;

    const contactLines = [];
    if (b.phone) contactLines.push(`<p><strong>Phone:</strong> <a href="tel:${escHtml(b.phone)}">${escHtml(b.phone)}</a></p>`);
    if (b.website) contactLines.push(`<p><strong>Website:</strong> <a href="${escHtml(b.website)}" target="_blank" rel="noopener">${escHtml(b.website)}</a></p>`);
    if (b.postcode) contactLines.push(`<p><strong>Location:</strong> ${escHtml(b.postcode)}, Cornwall</p>`);

    const featuredTag = b.subscription_status === 'active' ? '<span class="featured-tag">★ Featured</span>' : '';
    const logo = b.logo_url ? `<img class="biz-logo" src="${escHtml(b.logo_url)}" alt="${escHtml(b.name)} logo" />` : '';

    const body = `
      <div class="breadcrumbs"><a href="/directory">Cornwall Business Directory</a> › <a href="${categoryPath(b.category)}">${escHtml(b.category)}</a> › ${escHtml(b.name)}</div>
      <div class="biz-header">
        ${logo}
        <div>
          <h1 style="margin-bottom:2px;">${escHtml(b.name)}${featuredTag}</h1>
          <p class="lede" style="margin:0;">${escHtml(b.category)} in Cornwall${b.postcode ? ' · ' + escHtml(b.postcode) : ''}</p>
        </div>
      </div>
      ${b.description ? `<p>${escHtml(b.description)}</p>` : ''}
      ${contactLines.join('')}
      <div class="btn-line">
        <a href="${categoryPath(b.category)}">← More ${escHtml(b.category)} businesses in Cornwall</a>
      </div>
      ${LIST_BUSINESS_CTA}`;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: b.name,
      description: b.description || undefined,
      telephone: b.phone || undefined,
      image: b.logo_url || undefined,
      url: b.website || `${SITE_URL}${businessPath(b)}`,
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Cornwall',
        addressRegion: 'Cornwall',
        postalCode: b.postcode || undefined,
        addressCountry: 'GB',
      },
    };

    res.set('Cache-Control', 'public, max-age=300');
    res.send(pageShell({ title, description, canonicalPath: businessPath(b), jsonLd, bodyHtml: body, ogImage: b.logo_url || undefined }));
  } catch (err) {
    console.error('[seoPages] business page failed:', err.message);
    res.status(500).send(pageShell({
      title: 'Cornwall Business Directory | Cornwall Radar',
      description: 'A free directory of local businesses across Cornwall.',
      canonicalPath: '/directory',
      bodyHtml: '<h1>Temporarily unavailable</h1><p class="lede">Please try again shortly.</p>',
    }));
  }
});

// GET /sitemap.xml — every page in this file, so search engines don't have
// to crawl-discover each business page one link at a time. Referenced from
// robots.txt. Regenerated on every request from live data (cheap: one
// query, no images/heavy joins) rather than written to disk at deploy time,
// so a brand-new listing is in the sitemap immediately, not just once
// someone redeploys.
router.get('/sitemap.xml', async (req, res) => {
  const urls = [`${SITE_URL}/`, `${SITE_URL}/directory`, ...BUSINESS_CATEGORIES.map((c) => `${SITE_URL}${categoryPath(c)}`)];

  if (supabaseConfigured()) {
    try {
      const { data } = await supabaseAdmin.from('businesses').select('id, name');
      for (const b of (data || [])) urls.push(`${SITE_URL}${businessPath(b)}`);
    } catch (err) {
      console.error('[seoPages] sitemap business lookup failed:', err.message);
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((u) => `  <url><loc>${escHtml(u)}</loc></url>`).join('\n')
    + `\n</urlset>`;

  res.set('Content-Type', 'application/xml');
  res.set('Cache-Control', 'public, max-age=1800');
  res.send(xml);
});

module.exports = router;
