// Discovers what can be sold on the event under test (seat map, categories, standing section)
// through the public shop API - the same data the browser gets.
import { rng, shuffle } from './common.mjs';

export async function loadWorld(cfg, vu, eventId) {
  const mapRes = await vu.call('SETUP_SEATMAP', 'GET', `/api/events/${eventId}/seatmap`);
  if (mapRes.status !== 200 || !Array.isArray(mapRes.body?.seats)) {
    throw new Error(`Cannot load seat map of event ${eventId}: HTTP ${mapRes.status}`);
  }
  const map = mapRes.body;
  const avail = (await vu.call('SETUP_AVAILABILITY', 'GET', `/api/events/${eventId}/availability`))
    .body;
  const unavailable = new Set([...(avail.taken ?? []), ...(avail.locked ?? [])]);
  const seated = new Set(map.sections.filter((s) => s.type === 'SEATED').map((s) => s.id));
  const ga = map.sections.find((s) => s.type === 'STANDING') ?? null;
  const rand = rng(cfg.seed);
  // Plain seats only (no wheelchair / companion features: those have extra booking rules).
  const usable = map.seats.filter((s) => seated.has(s.s) && !s.f && !unavailable.has(s.i));
  // Hot seats: the first N seats of the first price category, so they are spread over a few rows.
  const firstCategory = [...map.categories].sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const hotSeats = usable
    .filter((s) => s.c === firstCategory.id)
    .slice(0, cfg.hot)
    .map((s) => s.i);
  const hotSet = new Set(hotSeats);
  const cold = shuffle(
    rand,
    usable.filter((s) => !hotSet.has(s.i)).map((s) => s.i),
  );
  const gaAvail = ga ? (avail.ga?.[ga.id] ?? 0) : 0;
  return {
    eventId,
    map,
    categories: map.categories,
    seatTotal: map.seats.length,
    usable: usable.map((s) => s.i),
    hotSeats,
    coldSeats: cold,
    ga: ga ? { id: ga.id, available: gaAvail } : null,
    ticketTypes: map.ticketTypes,
  };
}
