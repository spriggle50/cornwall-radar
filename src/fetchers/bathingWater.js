// Bathing Water Quality — Cornwall's designated bathing waters, with live
// classification and pollution-risk data shown via the Environment
// Agency's own official embeddable widget.
//
// This is a deliberate change of approach, not just another endpoint
// tweak. Three earlier versions of this file all tried to have this
// app's own server fetch and re-render the data from the Environment
// Agency's Linked Data API (environment.data.gov.uk/doc or /id/bathing-
// water.json) — every one of them eventually hit the same wall: that API
// sits behind an Azure Application Gateway that returns a bare 403
// Forbidden to server-to-server requests, confirmed on multiple URL
// paths and after trying browser-like headers, while this project's
// other Environment Agency calls (flood-monitoring) work fine from the
// same server. That points to bot/automated-traffic detection at the
// gateway in front of this one sub-service, not a bug in the request —
// something no amount of URL-guessing from this end was going to fix.
//
// The Environment Agency itself publishes a way around exactly this:
// an official embeddable widget (environment.data.gov.uk/bwq/widget/
// design), meant to be dropped into third-party sites. Because the
// widget loads inside the VISITOR'S browser rather than being fetched
// by this app's server, it never hits the same block — confirmed
// working with live, current-season data while building this (real
// 2025/2024/2023/2022 classifications and a sample date of "7 days
// ago" came back for Fistral South). So instead of re-implementing the
// Environment Agency's own display, this fetcher just returns Cornwall's
// site list (see src/lib/cornwallBathingWaters.js for where that list
// came from) and the exact widget URL for each one; the frontend embeds
// each as a small iframe. No network call happens here at all any more —
// there's nothing left for that gateway to block.
const { BATHING_WATERS } = require('../lib/cornwallBathingWaters');

const WIDGET_BASE = 'https://environment.data.gov.uk/bwq/widget/widget/widget1';

function widgetUrl(eubwid) {
  const fullUri = `http://environment.data.gov.uk/id/bathing-water/${eubwid}`;
  const url = new URL(WIDGET_BASE);
  url.searchParams.set('eu', fullUri);
  url.searchParams.set('history', 'true');
  url.searchParams.set('p', 'true');
  return url.toString();
}

async function getBathingWaterQuality() {
  const sites = BATHING_WATERS
    .map((site) => ({ name: site.name, eubwid: site.eubwid, widgetUrl: widgetUrl(site.eubwid) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    source: 'Environment Agency (Bathing Water Quality widget)',
    sites,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getBathingWaterQuality };
