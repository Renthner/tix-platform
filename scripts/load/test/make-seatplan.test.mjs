import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SEATS, buildSeatPlan, describePlan, rowLabel } from '../make-seatplan.mjs';

test('rowLabel counts A..Z, AA, AB', () => {
  assert.equal(rowLabel(0), 'A');
  assert.equal(rowLabel(25), 'Z');
  assert.equal(rowLabel(26), 'AA');
  assert.equal(rowLabel(27), 'AB');
  assert.equal(rowLabel(52), 'BA');
});

test('the default plan has exactly 3,600 seats, 3 categories and 4 wheelchair pairs', () => {
  const file = buildSeatPlan();
  const info = describePlan(file);
  assert.equal(DEFAULT_SEATS, 3600);
  assert.equal(info.seats, 3600);
  assert.equal(file.categories.length, 3);
  assert.equal(info.wheelchairSpaces, 4);
  assert.equal(info.companionSeats, 4);
  assert.equal(file.plan.sections.length, 7);
  assert.equal(file.plan.elements[0].type, 'STAGE');
  assert.equal(file.plan.entrances.length, 1);
  assert.equal(
    Object.values(info.perCategory).reduce((a, b) => a + b, 0),
    3600,
  );
});

test('any size hits the requested seat count and the output is deterministic', () => {
  for (const n of [100, 777, 3600, 5000]) {
    assert.equal(buildSeatPlan({ seats: n }).plan.seats.length, n);
  }
  assert.equal(JSON.stringify(buildSeatPlan()), JSON.stringify(buildSeatPlan()));
  assert.throws(() => buildSeatPlan({ seats: 10 }));
});

test('references are consistent, positions unique and seats do not overlap', () => {
  const { plan, categories } = buildSeatPlan();
  const sections = new Set(plan.sections.map((s) => s.id));
  const rows = new Map(plan.rows.map((r) => [r.id, r]));
  const cats = new Set(categories.map((c) => c.key));
  const ids = new Set();
  const positions = new Set();
  const spots = new Set();
  for (const s of plan.seats) {
    assert.ok(!ids.has(s.id));
    ids.add(s.id);
    assert.ok(sections.has(s.sectionId));
    assert.equal(rows.get(s.rowId).sectionId, s.sectionId);
    assert.ok(cats.has(s.categoryKey));
    const p = `${s.rowId}|${s.position}`;
    assert.ok(!positions.has(p));
    positions.add(p);
    const spot = `${Math.round(s.x)}|${Math.round(s.y)}`;
    assert.ok(!spots.has(spot), `overlapping seat ${s.id}`);
    spots.add(spot);
  }
  const byId = new Map(plan.seats.map((s) => [s.id, s]));
  for (const s of plan.seats.filter((x) => x.isCompanionSeat)) {
    assert.ok(byId.get(s.companionOfSeatId).isWheelchairSpace);
  }
  // 20-28 seats per full row, no row of the large default plan outside that range.
  const perRow = new Map();
  for (const s of plan.seats) perRow.set(s.rowId, (perRow.get(s.rowId) ?? 0) + 1);
  for (const n of perRow.values()) assert.ok(n >= 20 && n <= 28, `row with ${n} seats`);
});

test('blocks of the same tier do not overlap and every seat lies inside its block', () => {
  const { plan } = buildSeatPlan();
  const rects = plan.sections.map((s) => ({ name: s.name, ...s.geometry }));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlap =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!overlap, `${a.name} overlaps ${b.name}`);
    }
  }
  const byId = new Map(plan.sections.map((s) => [s.id, s.geometry]));
  for (const s of plan.seats) {
    const g = byId.get(s.sectionId);
    assert.ok(s.x >= g.x && s.x <= g.x + g.width && s.y >= g.y && s.y <= g.y + g.height);
  }
  assert.ok(plan.canvasWidth > 0 && plan.canvasHeight > 0);
  const stage = plan.elements[0].geometry;
  assert.ok(stage.y + stage.height < Math.min(...rects.map((r) => r.y)));
});
