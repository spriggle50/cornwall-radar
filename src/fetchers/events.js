// Local ticketed events — Ticketmaster Discovery API.
//
// Eventbrite was originally layered in here too, matching a separately-run
// project's own code — but Eventbrite permanently shut off public event
// search for standard developer keys in February 2020 (the /v3/events/search/
// endpoint now returns a 404 "path does not exist" for everyone, not just
// this key — there's no fix or workaround available, only organisation- or
// venue-scoped listing, which isn't useful for "what's on near me"). So it's
// been removed rather than left in to throw a permanent error. Ticketmaster's
// public search API is still live and working.
//
// Ticketmaster is optional (free developer registration, no card required)
// — with no key set this section just reports "not configured", and the
// free What's On RSS feed (whatson.js) alongside it keeps working regardless.
//
// Cornwall residents commonly travel to Plymouth for bigger gigs/shows, so
// a second search centred there is always layered in alongside the local
// search point — same as the reference implementation does for any
// Cornish town.

const { nearestTown } = require('../lib/cornwallTowns');

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;

const DEFAULT_LAT = 50.2632;
const DEFAULT_LON = -5.0510;
const PLYMOUTH = { lat: 50.3755, lon: -4.1427, label: 'Plymouth' };

async function fetchTicketmaster(searches) {
  const startDate = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
  const endDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T23:59:59Z';

  const results = [];
  for (const search of searches) {
    const params = new URLSearchParams({
      latlong: `${search.lat},${search.lon}`,
      radius: '20',
      unit: 'miles',
      size: '15',
      startDateTime: startDate,
      endDateTime: endDate,
      countryCode: 'GB',
      sort: 'date,asc',
      apikey: TICKETMASTER_API_KEY,
    });
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ticketmaster request failed (${search.label}): ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
    }
    const data = await res.json();
    if (data.fault) throw new Error(`Ticketmaster error (${search.label}): ${data.fault.faultstring || 'unknown fault'}`);

    const events = (data._embedded?.events || []).map((e) => ({
      name: e.name,
      date: e.dates?.start?.localDate || null,
      time: e.dates?.start?.localTime ? e.dates.start.localTime.slice(0, 5) : null,
      venue: e._embedded?.venues?.[0]?.name || 'Local venue',
      city: e._embedded?.venues?.[0]?.city?.name || search.label,
      category: e.classifications?.[0]?.segment?.name || 'Event',
      subCategory: e.classifications?.[0]?.genre?.name || null,
      url: e.url || null,
      image: e.images?.find((i) => i.ratio === '3_2' && i.width > 300)?.url || e.images?.[0]?.url || null,
      priceMin: e.priceRanges?.[0]?.min ?? null,
      source: 'ticketmaster',
    }));
    results.push(...events);
  }
  return results;
}

async function getEvents({ lat = DEFAULT_LAT, lon = DEFAULT_LON } = {}) {
  const tmConfigured = !!TICKETMASTER_API_KEY;

  if (!tmConfigured) {
    return {
      source: 'Events',
      configured: false,
      message: 'TICKETMASTER_API_KEY is not set — add it to .env for ticketed local events (free developer registration at developer.ticketmaster.com).',
      events: [],
    };
  }

  const town = nearestTown(lat, lon);
  const searches = [{ lat, lon, label: town ? town.name : 'Cornwall' }, PLYMOUTH];

  let tmEvents = [];
  let tmError = null;
  try {
    tmEvents = await fetchTicketmaster(searches);
  } catch (err) {
    tmError = err.message;
  }

  // Still de-duplicate (by name + date) — the local and Plymouth searches
  // can both surface the same regional tour date.
  const seen = new Set();
  const unique = tmEvents.filter((e) => {
    const key = `${e.name}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

  return {
    source: 'Ticketmaster',
    configured: true,
    events: unique,
    sourceCounts: { ticketmaster: unique.length },
    sourceNotes: tmError ? ['Ticketmaster: ' + tmError] : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getEvents };
