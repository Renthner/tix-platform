import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assignEvent,
  emptyEventStats,
  leakReport,
  mergeEventStats,
  parseEventList,
  parseEventWeights,
  parseMultiEventRatio,
  perEventHotCheck,
} from '../lib/events.mjs';
import { bestAvailableCategories } from '../lib/world.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('event list: one or several distinct UUIDs, slugs positional', () => {
  assert.deepEqual(parseEventList(A, undefined), {
    ok: true,
    events: [{ eventId: A, eventSlug: null }],
  });
  assert.deepEqual(parseEventList(A, 'gala').events, [{ eventId: A, eventSlug: 'gala' }]);
  const two = parseEventList(`${A}, ${B}`, 'a,b');
  assert.equal(two.ok, true);
  assert.deepEqual(
    two.events.map((e) => [e.eventId, e.eventSlug]),
    [
      [A, 'a'],
      [B, 'b'],
    ],
  );
  assert.equal(parseEventList(A.toUpperCase(), undefined).ok, true);
  for (const bad of [
    undefined,
    true,
    '',
    'nope',
    `${A},nope`,
    `${A},${A}`,
    `${A},${A.toUpperCase()}`,
  ]) {
    assert.equal(parseEventList(bad, undefined).ok, false, String(bad));
  }
  // slug count must match the id count; a bare flag is refused
  assert.equal(parseEventList(`${A},${B}`, 'only-one').ok, false);
  assert.equal(parseEventList(`${A},${B}`, 'a,').ok, false);
  assert.equal(parseEventList(A, true).ok, false);
  const many = Array.from(
    { length: 21 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
  assert.equal(parseEventList(many.slice(0, 20).join(','), undefined).ok, true);
  assert.equal(parseEventList(many.join(','), undefined).ok, false);
});

test('event weights and multi-event ratio validation', () => {
  assert.deepEqual(parseEventWeights(undefined, 3), { ok: true, weights: null });
  assert.deepEqual(parseEventWeights('3,1,1', 3), { ok: true, weights: [3, 1, 1] });
  assert.deepEqual(parseEventWeights('0.5, 1.5', 2).weights, [0.5, 1.5]);
  for (const bad of [true, '', '3,1', '3,0,1', '3,-1,1', '3,x,1', '1,1,1,1']) {
    assert.equal(parseEventWeights(bad, 3).ok, false, String(bad));
  }
  assert.equal(parseMultiEventRatio(undefined, 1).ratio, 0);
  assert.equal(parseMultiEventRatio(undefined, 3).ratio, 0.1);
  assert.equal(parseMultiEventRatio('0.25', 3).ratio, 0.25);
  assert.equal(parseMultiEventRatio('0.25', 1).ratio, 0); // ignored with one event
  for (const bad of [true, '', '1.5', '-0.1', 'x']) {
    assert.equal(parseMultiEventRatio(bad, 3).ok, false, String(bad));
  }
});

test('assignEvent: even split, single event, determinism', () => {
  const counts = [0, 0, 0];
  for (let id = 0; id < 999; id++) counts[assignEvent(id, 3)]++;
  assert.deepEqual(counts, [333, 333, 333]);
  for (let id = 0; id < 50; id++) assert.equal(assignEvent(id, 1), 0);
  for (let id = 0; id < 50; id++) {
    assert.equal(assignEvent(id, 4, [2, 1, 1, 1]), assignEvent(id, 4, [2, 1, 1, 1]));
  }
});

test('assignEvent: weights split proportionally, independent of contiguous id slices', () => {
  const weights = [3, 1, 1];
  const counts = [0, 0, 0];
  for (let id = 0; id < 1000; id++) counts[assignEvent(id, 3, weights)]++;
  assert.deepEqual(
    counts.map((c) => Math.round(c / 10)),
    [60, 20, 20],
  );
  for (const c of [600, 200, 200].keys()) {
    assert.ok(Math.abs(counts[c] - [600, 200, 200][c]) <= 5, `event ${c}: ${counts[c]}`);
  }
  // a worker slice (contiguous ids) still gets every event in about the right share
  const slice = [0, 0, 0];
  for (let id = 250; id < 500; id++) slice[assignEvent(id, 3, weights)]++;
  assert.ok(slice[0] >= 140 && slice[0] <= 160, String(slice));
  assert.ok(slice[1] >= 40 && slice[2] >= 40, String(slice));
});

test('mergeEventStats sums workers and unions hot seats', () => {
  const w1 = [
    { ...emptyEventStats(), shoppers: 3, hotWon: 1, hotLost: 2, hotWonSeats: ['h1'] },
    { ...emptyEventStats(), shoppers: 2, checkoutsOk: 1, multiEventCarts: 1 },
  ];
  const w2 = [
    { ...emptyEventStats(), shoppers: 4, hotWon: 1, hotLost: 3, hotWonSeats: ['h1', 'h2'] },
    { ...emptyEventStats(), shoppers: 1, coldLocks: 2 },
  ];
  const [a, b] = mergeEventStats(2, [w1, w2, undefined]);
  assert.equal(a.shoppers, 7);
  assert.equal(a.hotWon, 2);
  assert.equal(a.hotLost, 5);
  assert.deepEqual([...a.hotWonSeats].sort(), ['h1', 'h2']);
  assert.equal(b.shoppers, 3);
  assert.equal(b.coldLocks, 2);
  assert.equal(b.checkoutsOk, 1);
  assert.equal(b.multiEventCarts, 1);
});

test('leakReport: per event, total, names the leaking events', () => {
  const single = leakReport([{ eventId: A, lockedBefore: new Set(['x']), lockedAfter: ['x'] }]);
  assert.equal(single.total, 0);
  assert.equal(single.detail, '0 seats still held');
  const multi = leakReport([
    { eventId: A, lockedBefore: ['x'], lockedAfter: ['x', 'y'] },
    { eventId: B, lockedBefore: [], lockedAfter: [] },
    { eventId: C, lockedBefore: [], lockedAfter: new Set(['p', 'q']) },
  ]);
  assert.equal(multi.total, 3);
  assert.deepEqual(
    multi.perEvent.map((e) => e.leaked),
    [1, 0, 2],
  );
  assert.match(multi.detail, /^3 seats still held/);
  assert.match(multi.detail, new RegExp(`${A} \\(1\\), ${C} \\(2\\)`));
  assert.doesNotMatch(multi.detail, new RegExp(B));
});

test('perEventHotCheck: every event must be won and refused', () => {
  const ev = (eventId, over = {}) => ({
    eventId,
    shoppers: 100,
    hotSeats: 20,
    hotWon: 20,
    hotLost: 80,
    ...over,
  });
  assert.equal(perEventHotCheck([ev(A), ev(B)]).ok, true);
  const noLoss = perEventHotCheck([ev(A), ev(B, { hotLost: 0 })]);
  assert.equal(noLoss.ok, false);
  assert.match(noLoss.detail, new RegExp(B));
  assert.doesNotMatch(noLoss.detail, new RegExp(A));
  assert.equal(perEventHotCheck([ev(A), ev(B, { hotWon: 0 })]).ok, false);
  // a single shopper cannot be refused by anybody
  assert.equal(perEventHotCheck([ev(A), ev(B, { shoppers: 1, hotLost: 0, hotWon: 1 })]).ok, true);
});

test('bestAvailableCategories: offered, in best-available blocks, at least 2 plain seats', () => {
  const map = {
    sections: [
      { id: 's1', type: 'SEATED', isBestAvailableEnabled: true },
      { id: 's2', type: 'SEATED', isBestAvailableEnabled: false },
      { id: 'ga', type: 'STANDING', isBestAvailableEnabled: true },
    ],
    categories: [
      { id: 'c1', bestAvailable: true },
      { id: 'c2', bestAvailable: false }, // switched off for the category
      { id: 'c3', bestAvailable: true }, // only 1 plain seat (rest wheelchair, filtered before)
      { id: 'c4', bestAvailable: true }, // seats only in a block without best available
      { id: 'c5' }, // old server without the flag = offered
    ],
  };
  const seat = (i, s, c) => ({ i, s, c });
  const usable = [
    seat('a', 's1', 'c1'),
    seat('b', 's1', 'c1'),
    seat('c', 's1', 'c2'),
    seat('d', 's1', 'c2'),
    seat('e', 's1', 'c3'),
    seat('f', 's2', 'c4'),
    seat('g', 's2', 'c4'),
    seat('h', 's1', 'c5'),
    seat('i', 's1', 'c5'),
    seat('j', 's1', 'c5'),
  ];
  assert.deepEqual(bestAvailableCategories(map, usable), [
    { id: 'c1', seats: 2 },
    { id: 'c5', seats: 3 },
  ]);
});
