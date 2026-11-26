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
  // Hot seats: the first N seats of the first price category with plain seats (a wheelchair-only
  // category has none), so they are spread over a few rows.
  const sorted = [...map.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  const firstCategory = sorted.find((c) => usable.some((s) => s.c === c.id)) ?? sorted[0];
  const hotSeats = usable
    .filter((s) => s.c === firstCategory?.id)
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
    bestAvailableCategories: bestAvailableCategories(map, usable),
    seatTotal: map.seats.length,
    usable: usable.map((s) => s.i),
    hotSeats,
    coldSeats: cold,
    ga: ga ? { id: ga.id, available: gaAvail } : null,
    ticketTypes: map.ticketTypes,
  };
}

/**
 * Categories a best-available request can succeed on, like the server sees them: best available
 * offered for the category (`bestAvailable`; absent on old servers = offered) and at least 2 plain
 * usable seats in SEATED sections with best available enabled. `usable` = plain, free seats of the
 * public map. Returns [{id, seats}] (seats = number of such seats, to clamp the quantity).
 */
export function bestAvailableCategories(map, usable) {
  const enabled = new Set(
    map.sections
      .filter((s) => s.type === 'SEATED' && s.isBestAvailableEnabled !== false)
      .map((s) => s.id),
  );
  const perCategory = new Map();
  for (const s of usable) {
    if (enabled.has(s.s)) perCategory.set(s.c, (perCategory.get(s.c) ?? 0) + 1);
  }
  return map.categories
    .filter((c) => c.bestAvailable !== false && (perCategory.get(c.id) ?? 0) >= 2)
    .map((c) => ({ id: c.id, seats: perCategory.get(c.id) }));
}
