#!/usr/bin/env node
// Generates a large seating plan file (*.tixplan.json, format "tix-seatmap" v2) for load tests.
// Import it in Admin -> Venues -> <venue> -> "Import seating plan". See docs/LOAD-TEST.md.
//
//   node scripts/load/make-seatplan.mjs [--seats 3600] [--out loadtest-seatplan.tixplan.json] [--name "Load test hall"]
//
// Plain Node ESM, no dependencies. The output is deterministic (local keys "s1", "r1", "p1" ...;
// the importer maps them to fresh UUIDs), so the same options always give the same file.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SEATS = 3600;
export const MIN_SEATS = 100;
/** The importer accepts at most 100,000 seats and 10,000 rows per plan. */
export const MAX_SEATS = 90_000;

const SEAT_SPACING = 22;
const ROW_SPACING = 26;
const BLOCK_PAD_X = 44; // room for the row labels left and right of the seats
const BLOCK_PAD_Y = 40;
const BLOCK_GAP_X = 40; // aisle between blocks
const BLOCK_GAP_Y = 110; // between Parkett / Balkon / Loge
const MARGIN = 80;
const SIDE_WIDTH = 22; // widest row of a side block (seats)
const MID_WIDTH = 28; // widest row of a middle block / the Loge

/** Share of all seats, price category (index into CATEGORIES), column, best-available priority. */
const BLOCKS = [
  { name: 'Parkett links', tier: 'Parkett', col: 0, weight: 600, cat: 1, priority: 30 },
  { name: 'Parkett Mitte', tier: 'Parkett', col: 1, weight: 780, cat: 0, priority: 10 },
  { name: 'Parkett rechts', tier: 'Parkett', col: 2, weight: 600, cat: 1, priority: 30 },
  { name: 'Balkon links', tier: 'Balkon', col: 0, weight: 420, cat: 2, priority: 70 },
  { name: 'Balkon Mitte', tier: 'Balkon', col: 1, weight: 420, cat: 1, priority: 50 },
  { name: 'Balkon rechts', tier: 'Balkon', col: 2, weight: 420, cat: 2, priority: 70 },
  { name: 'Loge', tier: 'Loge', col: 1, weight: 360, cat: 1, priority: 40 },
];

const CATEGORIES = [
  { key: 'cat1', name: 'Cat 1', color: '#C0392B' },
  { key: 'cat2', name: 'Cat 2', color: '#2E86C1' },
  { key: 'cat3', name: 'Cat 3', color: '#27AE60' },
];

/** Wheelchair / companion pairs: [block, row index (0 = front), side]. */
const SPECIAL_PAIRS = [
  ['Parkett links', 'last', 'start'],
  ['Parkett rechts', 'last', 'end'],
  ['Balkon links', 'first', 'start'],
  ['Balkon rechts', 'first', 'end'],
];

/** A, B ... Z, AA, AB ... */
export function rowLabel(index) {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** Splits `total` over the weights (largest remainder), the sum is always exact. */
function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (total * w) / sum);
  const counts = exact.map(Math.floor);
  let rest = total - counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    counts[i] += 1;
    rest -= 1;
  }
  return counts;
}

/** Seats per row, front to back (the shorter rows are in front), every row <= maxWidth. */
function rowSizes(count, maxWidth) {
  if (count <= 0) return [];
  const rows = Math.ceil(count / maxWidth);
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, i) => base + (i >= rows - extra ? 1 : 0));
}

export function buildSeatPlan({ seats = DEFAULT_SEATS, name = 'Load test hall' } = {}) {
  if (!Number.isInteger(seats) || seats < MIN_SEATS || seats > MAX_SEATS) {
    throw new Error(`seats must be an integer between ${MIN_SEATS} and ${MAX_SEATS}`);
  }
  const counts = apportion(
    seats,
    BLOCKS.map((b) => b.weight),
  );
  const colWidth = (col) => (col === 1 ? MID_WIDTH : SIDE_WIDTH) * SEAT_SPACING + 2 * BLOCK_PAD_X;
  const colX = [MARGIN];
  colX.push(colX[0] + colWidth(0) + BLOCK_GAP_X);
  colX.push(colX[1] + colWidth(1) + BLOCK_GAP_X);
  const canvasWidth = colX[2] + colWidth(2) + MARGIN;
  const midCenter = colX[1] + colWidth(1) / 2;

  const stageTop = 40;
  const stageHeight = 100;
  let tierTop = stageTop + stageHeight + 60;

  const sections = [];
  const rows = [];
  const seatList = [];
  const specials = [];
  let seatNo = 0;
  let rowNo = 0;

  const tiers = ['Parkett', 'Balkon', 'Loge'];
  for (const tier of tiers) {
    let tierBottom = tierTop;
    BLOCKS.forEach((block, bi) => {
      if (block.tier !== tier) return;
      const sizes = rowSizes(counts[bi], block.col === 1 ? MID_WIDTH : SIDE_WIDTH);
      const sectionKey = `s${sections.length + 1}`;
      const width = colWidth(block.col);
      const height = Math.max(0, sizes.length - 1) * ROW_SPACING + 2 * BLOCK_PAD_Y;
      const x = colX[block.col];
      sections.push({
        id: sectionKey,
        type: 'SEATED',
        name: block.name,
        ticketLabel: block.name,
        geometry: { type: 'rect', x, y: tierTop, width, height, rotation: 0 },
        label: { position: { x: x + width / 2, y: tierTop - 14 }, fontSize: 16, rotation: 0 },
        color: null,
        sortOrder: sections.length,
        entranceId: 'e1',
        categoryKey: CATEGORIES[block.cat].key,
        capacity: null,
        bestAvailablePriority: block.priority,
        isBestAvailableEnabled: true,
        isActive: true,
        showNameOnMap: true,
        showLabelOnTicket: true,
      });
      tierBottom = Math.max(tierBottom, tierTop + height);
      const centerX = x + width / 2;
      sizes.forEach((n, ri) => {
        const y = tierTop + BLOCK_PAD_Y + ri * ROW_SPACING;
        const startX = centerX - ((n - 1) * SEAT_SPACING) / 2;
        const rowKey = `r${(rowNo += 1)}`;
        rows.push({
          id: rowKey,
          sectionId: sectionKey,
          label: rowLabel(ri),
          sortOrder: ri,
          geometry: {
            curve: {
              type: 'straight',
              start: { x: startX, y },
              end: { x: startX + (n - 1) * SEAT_SPACING, y },
            },
            seatSpacing: SEAT_SPACING,
            numbering: 'ASCENDING',
            labelPlacement: 'BOTH',
            seatOrientation: { mode: 'FIXED', angle: 0 },
          },
        });
        for (let pos = 1; pos <= n; pos += 1) {
          seatList.push({
            id: `p${(seatNo += 1)}`,
            sectionId: sectionKey,
            rowId: rowKey,
            tableElementId: null,
            label: String(pos),
            position: pos,
            x: startX + (pos - 1) * SEAT_SPACING,
            y,
            rotation: 0,
            bestAvailableRank: null,
            isWheelchairSpace: false,
            isCompanionSeat: false,
            companionOfSeatId: null,
            hasRestrictedView: false,
            blockReason: null,
            blockNote: null,
            attributes: {},
            symbolId: null,
            categoryKey: CATEGORIES[block.cat].key,
          });
        }
      });
    });
    tierTop = tierBottom + BLOCK_GAP_Y;
  }

  // Wheelchair space + companion seat next to each other in the first / last row of a block.
  for (const [blockName, which, side] of SPECIAL_PAIRS) {
    const section = sections.find((s) => s.name === blockName);
    if (!section) continue;
    const sectionRows = rows.filter((r) => r.sectionId === section.id);
    const row = which === 'first' ? sectionRows[0] : sectionRows[sectionRows.length - 1];
    if (!row) continue;
    const inRow = seatList.filter((s) => s.rowId === row.id);
    if (inRow.length < 4) continue;
    const [wheelchair, companion] =
      side === 'start' ? [inRow[0], inRow[1]] : [inRow[inRow.length - 1], inRow[inRow.length - 2]];
    wheelchair.isWheelchairSpace = true;
    companion.isCompanionSeat = true;
    companion.companionOfSeatId = wheelchair.id;
    specials.push({ block: blockName, row: row.label, wheelchair: wheelchair.label });
  }

  const lastBottom = tierTop - BLOCK_GAP_Y;
  const canvasHeight = Math.ceil(lastBottom + 60 + 80);

  return {
    format: 'tix-seatmap',
    version: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: { appVersion: 'load-test-generator' },
    plan: {
      name,
      canvasWidth,
      canvasHeight,
      settings: {
        gridSize: 10,
        snapToGrid: true,
        seatRadius: 8,
        showSeatNumbers: true,
        backgroundOpacity: 0.35,
        wheelchairLabel: { mode: 'ICON' },
        companionLabel: { mode: 'ICON' },
      },
      entrances: [
        {
          id: 'e1',
          name: 'Main entrance',
          code: 'A',
          x: midCenter,
          y: lastBottom + 60,
          sortOrder: 0,
        },
      ],
      sections,
      rows,
      elements: [
        {
          id: 'el1',
          type: 'STAGE',
          sectionId: null,
          label: 'Stage',
          geometry: {
            type: 'rect',
            x: midCenter - 340,
            y: stageTop,
            width: 680,
            height: stageHeight,
            rotation: 0,
            cornerRadius: 8,
          },
          style: { fill: '#374151', textColor: '#FFFFFF', fontSize: 28, fontWeight: 'bold' },
          imageKey: null,
          zIndex: 0,
        },
      ],
      seats: seatList,
    },
    categories: CATEGORIES.map((c) => ({ ...c, translations: {} })),
    symbols: [],
    images: [],
    background: null,
  };
}

/** Per block / per category seat counts and the special seat pairs of a built plan. */
export function describePlan(file) {
  const sectionName = new Map(file.plan.sections.map((s) => [s.id, s.name]));
  const categoryName = new Map(file.categories.map((c) => [c.key, c.name]));
  const perBlock = {};
  const perCategory = {};
  const rowsPerBlock = {};
  for (const s of file.plan.seats) {
    const b = sectionName.get(s.sectionId);
    const c = categoryName.get(s.categoryKey);
    perBlock[b] = (perBlock[b] ?? 0) + 1;
    perCategory[c] = (perCategory[c] ?? 0) + 1;
  }
  for (const r of file.plan.rows) {
    const b = sectionName.get(r.sectionId);
    rowsPerBlock[b] = (rowsPerBlock[b] ?? 0) + 1;
  }
  return {
    seats: file.plan.seats.length,
    rows: file.plan.rows.length,
    perBlock,
    rowsPerBlock,
    perCategory,
    wheelchairSpaces: file.plan.seats.filter((s) => s.isWheelchairSpace).length,
    companionSeats: file.plan.seats.filter((s) => s.isCompanionSeat).length,
  };
}

function parseArgs(argv) {
  const out = {
    seats: DEFAULT_SEATS,
    out: 'loadtest-seatplan.tixplan.json',
    name: 'Load test hall',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[(i += 1)];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--seats') out.seats = Number(value());
    else if (arg === '--out') out.out = value();
    else if (arg === '--name') out.name = value();
    else throw new Error(`Unknown option ${arg}`);
  }
  return out;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const file = buildSeatPlan({ seats: options.seats, name: options.name });
    const json = JSON.stringify(file);
    const target = resolve(options.out);
    writeFileSync(target, json);
    const info = describePlan(file);
    console.log(`Wrote ${target}`);
    console.log(`  size   ${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  seats  ${info.seats} in ${info.rows} rows`);
    for (const [block, n] of Object.entries(info.perBlock)) {
      console.log(
        `    ${block.padEnd(16)} ${String(n).padStart(5)} seats, ${info.rowsPerBlock[block]} rows`,
      );
    }
    for (const [cat, n] of Object.entries(info.perCategory)) {
      console.log(`  ${cat.padEnd(18)} ${String(n).padStart(5)} seats`);
    }
    console.log(
      `  wheelchair spaces ${info.wheelchairSpaces}, companion seats ${info.companionSeats}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
