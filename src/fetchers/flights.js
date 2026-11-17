// Live flight arrivals & departures — Cornwall Airport Newquay (NQY).
//
// There's no real free flight-data API for a small regional airport like
// Newquay: every option checked (Aviationstack, AeroDataBox, FlightAware,
// Aviation Edge) either has a free-tier call limit far too low for
// continuous polling (100-600 calls/month vs ~1,400/month for a 30-min
// refresh cycle) or requires a paid plan outright (Aviation Edge's
// cheapest real plan renews at $299/month after a $7 first month —
// disproportionate for one free dashboard card). So this scrapes the
// airport's own public live-flights page instead
// (https://www.cornwallairportnewquay.com/live-flights/), which is free,
// official, and server-renders real flight data with no JS needed to read
// it.
//
// Structure confirmed directly against the live page's DOM (not guessed):
// each flight is a `.live-flight-info-row` div; fields are tagged with
// stable semantic classes that belong to the airport's own "live flight"
// widget (`.live-flight-arrival-port` for destination/origin,
// `.live-flight-company` for airline, `.flight-status` for status — whose
// class list also carries a machine-readable status slug like
// `ontime`/`departed`/`landed`/`delayed`/`cancelled`) rather than
// Elementor's auto-generated per-widget IDs, which differ between sections
// (today vs upcoming, departures vs arrivals) and can't be relied on.
// Direction (departure vs arrival) is read from the presence of an
// "Arriving From:" label rather than page position, for the same reason.
//
// Being a scrape rather than a stable API contract, this can break if the
// airport redesigns the page — same risk class as the other directory-
// style scrapes already in this app. A hard timeout plus a try/catch
// around the parse keep a page-structure change from taking down the rest
// of the dashboard; it just reports unavailable until this file is
// updated.
const cheerio = require('cheerio');

const LIVE_FLIGHTS_URL = 'https://www.cornwallairportnewquay.com/live-flights/';

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function statusSlugOf($status) {
  const classes = ($status.attr('class') || '').split(/\s+/);
  return (
    classes.find(
      (c) => c && !c.startsWith('elementor') && c !== 'flight-status' && c !== 'jet-listing'
    ) || null
  );
}

function parseRow($, row) {
  const $row = $(row);

  const fields = $row
    .find('.jet-listing-dynamic-field__content')
    .toArray()
    .map((el) => {
      const $el = $(el);
      const $label = $el.find('.live-flight-mobile-titles');
      const labelText = $label.length ? cleanText($label.text()) : null;
      const full = cleanText($el.text());
      const value = labelText ? cleanText(full.slice(labelText.length)) : full;
      return { labelText, value };
    });

  const flightNumberField = fields.find((f) => f.labelText === 'Flight Number:');
  const scheduledField = fields.find((f) => f.labelText === 'Scheduled Time:');
  const expectedField = fields.find((f) => /^Expected Time:/i.test(f.value));
  const dateField = fields.find((f) => f.labelText === 'Date:');
  const isArrival = fields.some((f) => f.labelText === 'Arriving From:');

  const $port = $row.find('.live-flight-arrival-port .jet-listing-dynamic-field__content').first();
  const place = cleanText($port.text()).replace(/^Arriving From:\s*/i, '') || null;

  const airline = cleanText($row.find('.live-flight-company .ca-title-case').first().text()) || null;

  const $status = $row.find('.flight-status').first();
  const statusText = cleanText($status.text()) || null;
  const statusSlug = $status.length ? statusSlugOf($status) : null;

  let expected = null;
  if (expectedField) {
    const m = expectedField.value.match(/^Expected Time:\s*(.+)$/i);
    expected = m ? cleanText(m[1]) : null;
  }

  return {
    direction: isArrival ? 'arrival' : 'departure',
    flightNumber: flightNumberField ? flightNumberField.value : null,
    airline,
    place, // destination for a departure, origin for an arrival
    scheduledTime: scheduledField ? scheduledField.value : null,
    expectedTime: expected,
    date: dateField ? dateField.value : null, // set for "upcoming" rows; null means today
    statusText,
    statusSlug,
  };
}

async function getFlights() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(LIVE_FLIGHTS_URL, {
      headers: {
        'User-Agent': 'CornwallRadar/1.0 (local conditions dashboard; +https://cornwallradar.co.uk)',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Live flights request failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const rows = $('.live-flight-info-row')
    .toArray()
    .map((row) => parseRow($, row));

  const departures = rows.filter((r) => r.direction === 'departure');
  const arrivals = rows.filter((r) => r.direction === 'arrival');

  return {
    source: 'Cornwall Airport Newquay',
    configured: true,
    airport: { name: 'Cornwall Airport Newquay', code: 'NQY' },
    departures,
    arrivals,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getFlights, parseRow, cleanText };
