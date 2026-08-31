// Local ticketed events — Ticketmaster Discovery API + Eventbrite, combined
// the same way a separately-run project already does successfully. Both
// are optional (free developer registration, no card required) — with
// neither key set this whole section just reports "not configured", and
// the free What's On RSS feed (whatson.js) alongside it keeps working.
//
// Cornwall residents commonly travel to Plymouth for bigger gigs/shows, so
// a second search centred there is always layered in alongside the local
// search point — same as the reference implementation does for any
// Cornish town.

const { nearestTown } = require('../lib/cornwallTowns');

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;
const EVENTBRITE_API_KEY = process.env.EVENTBRITE_API_KEY;

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

async function fetchEventbrite(searches) {
  const results = [];
  for (const search of searches) {
    const params = new URLSearchParams({
      'location.address': `${search.label}, UK`,
      'location.within': '30mi',
      'start_date.range_start': new Date().toISOString().slice(0, 19) + 'Z',
      'start_date.range_end': new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
      expand: 'venue,category,logo',
      page_size: '10',
      sort_by: 'date',
      status: 'live',
    });
    const url = `https://www.eventbriteapi.com/v3/events/search/?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${EVENTBRITE_API_KEY}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(`Eventbrite request failed (${search.label}): ${data.error_description || data.error || res.statusText}`);
    }

    const events = (data.events || []).map((e) => ({
      name: decodeURIComponent(e.name?.text || 'Event'),
      date: e.start?.local ? e.start.local.slice(0, 10) : null,
      time: e.start?.local ? e.start.local.slice(11, 16) : null,
      venue: decodeURIComponent(e.venue?.name || 'Local venue'),
      city: decodeURIComponent(e.venue?.address?.city || search.label),
      category: e.category?.name || 'Community',
      subCategory: e.subcategory?.name || null,
      url: e.url || null,
      image: e.logo?.original?.url || e.logo?.url || null,
      priceMin: e.is_free ? 0 : null,
      source: 'eventbrite',
    }));
    results.push(...events);
  }
  return results;
}

async function getEvents({ lat = DEFAULT_LAT, lon = DEFAULT_LON } = {}) {
  const tmConfigured = !!TICKETMASTER_API_KEY;
  const ebConfigured = !!EVENTBRITE_API_KEY;

  if (!tmConfigured && !ebConfigured) {
    return {
      source: 'Events',
      configured: false,
      message: 'Neither TICKETMASTER_API_KEY nor EVENTBRITE_API_KEY is set — add either (or both) to .env for ticketed local events. Both offer free developer registration.',
      events: [],
    };
  }

  const town = nearestTown(lat, lon);
  const searches = [{ lat, lon, label: town ? town.name : 'Cornwall' }, PLYMOUTH];

  let tmEvents = [];
  let tmError = null;
  if (tmConfigured) {
    try {
      tmEvents = await fetchTicketmaster(searches);
    } catch (err) {
      tmError = err.message;
    }
  }

  let ebEvents = [];
  let ebError = null;
  if (ebConfigured) {
    try {
      ebEvents = await fetchEventbrite(searches);
    } catch (err) {
      ebError = err.message;
    }
  }

  const all = [...tmEvents, ...ebEvents];
  const seen = new Set();
  const unique = all.filter((e) => {
    const key = `${e.name}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

  const sourceNotes = [];
  if (tmError) sourceNotes.push('Ticketmaster: ' + tmError);
  if (ebError) sourceNotes.push('Eventbrite: ' + ebError);

  return {
    source: [tmConfigured && 'Ticketmaster', ebConfigured && 'Eventbrite'].filter(Boolean).join(' + '),
    configured: true,
    events: unique,
    // Counted post-dedupe so the badge shown in the UI matches what's
    // actually in the list, not the raw (pre-dedupe) per-source fetch totals.
    sourceCounts: {
      ticketmaster: unique.filter((e) => e.source === 'ticketmaster').length,
      eventbrite: unique.filter((e) => e.source === 'eventbrite').length,
    },
    sourceNotes: sourceNotes.length ? sourceNotes : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getEvents };
