import { describe, expect, it } from 'vitest';
import {
  SEAT_FLAG,
  checkCompanionSeats,
  companionPartners,
  computeTicketPrice,
  findBestAvailable,
  findOrphanSeats,
  elementLayout,
  layoutRowSeats,
  normalizePageLayout,
  rowLabelAnchors,
  seatPlanLabel,
  orientSeat,
  parseSetting,
  tangentAngleNear,
  seatMapDocumentSchema,
  seatNumbers,
  splitGross,
  type BestAvailableSeat,
  type RowSeat,
} from '../src';
import { signToken, verifyToken } from '../src/server';

const row = (states: string, start = 1): RowSeat[] =>
  [...states].map((c, i) => ({
    id: `s${start + i}`,
    position: start + i,
    state: c === 'm' ? 'mine' : c === 'x' ? 'taken' : 'free',
  }));

describe('orphan seat rule', () => {
  it('rejects a selection that strands a single seat at the row edge', () => {
    expect(findOrphanSeats(row('.mm..'))).toEqual(['s1']);
  });

  it('rejects a single gap between two selected seats', () => {
    expect(findOrphanSeats(row('m.m...'))).toEqual(['s2']);
  });

  it('accepts selections without single gaps', () => {
    expect(findOrphanSeats(row('mm...'))).toEqual([]);
    expect(findOrphanSeats(row('..mm..'))).toEqual([]);
  });

  it('allows an unavoidable single seat (only one seat would remain)', () => {
    expect(findOrphanSeats(row('mm.'))).toEqual([]);
    expect(findOrphanSeats(row('x.mmx'))).toEqual([]);
  });

  it('ignores pre-existing single seats the selection does not touch', () => {
    expect(findOrphanSeats(row('x.xmm..'))).toEqual([]);
  });

  it('treats aisles (position gaps) as row boundaries', () => {
    // Left block 1-3 has only one seat left over → unavoidable; seat 5 is behind the aisle.
    const seats: RowSeat[] = [
      { id: 'a', position: 1, state: 'free' },
      { id: 'b', position: 2, state: 'mine' },
      { id: 'c', position: 3, state: 'mine' },
      { id: 'd', position: 5, state: 'free' },
    ];
    expect(findOrphanSeats(seats)).toEqual([]);
    // Without the aisle the same selection would strand seats 1 and 4.
    expect(
      findOrphanSeats([...seats.slice(0, 3), { id: 'd', position: 4, state: 'free' }]),
    ).toEqual(['a', 'd']);
  });
});

describe('event page layout', () => {
  const refs = (layout: ReturnType<typeof normalizePageLayout>) =>
    layout.map((r) => r.map((i) => i.ref));
  it('converts the earlier flat format (boxes two per row)', () => {
    expect(
      refs(normalizePageLayout(['SHOP', 'DESCRIPTION', 'INFO_BOXES'], ['a', 'b', 'c'])),
    ).toEqual([['COVER'], ['SHOP'], ['DESCRIPTION'], ['box:a', 'box:b'], ['box:c']]);
  });
  it('keeps boxes next to the description, the plan alone, every block once', () => {
    const layout = normalizePageLayout(
      [
        [{ ref: 'DESCRIPTION', span: 2 }, { ref: 'box:a', span: 1 }, { ref: 'SHOP' }],
        [{ ref: 'box:a' }, { ref: 'box:gone' }],
      ],
      ['a', 'b'],
    );
    expect(refs(layout)).toEqual([['COVER'], ['DESCRIPTION', 'box:a'], ['SHOP'], ['box:b']]);
    expect(layout[1]![0]!.span).toBe(2);
  });
  it('keeps a stored cover block where the admin put it (e.g. left of the description)', () => {
    const layout = normalizePageLayout(
      [
        [
          { ref: 'COVER', span: 1 },
          { ref: 'DESCRIPTION', span: 2 },
        ],
        [{ ref: 'SHOP' }],
      ],
      [],
    );
    expect(refs(layout)).toEqual([['COVER', 'DESCRIPTION'], ['SHOP']]);
    expect(layout[0]![1]!.span).toBe(2);
  });
  it('inserts the cover first when an old layout lacks it', () => {
    expect(refs(normalizePageLayout([[{ ref: 'SHOP' }], [{ ref: 'DESCRIPTION' }]], []))).toEqual([
      ['COVER'],
      ['SHOP'],
      ['DESCRIPTION'],
    ]);
    expect(refs(normalizePageLayout(null, []))[0]).toEqual(['COVER']);
  });
  it('limits rows to three blocks', () => {
    const row = ['DESCRIPTION', 'box:a', 'box:b', 'box:c'].map((ref) => ({ ref }));
    expect(refs(normalizePageLayout([row], ['a', 'b', 'c']))).toEqual([
      ['COVER'],
      ['DESCRIPTION', 'box:a', 'box:b'],
      ['box:c'],
      ['SHOP'],
    ]);
  });
});

describe('special seat labels', () => {
  const wc = { label: '1', isWheelchairSpace: true, isCompanionSeat: false };
  const comp = { label: '2', isWheelchairSpace: false, isCompanionSeat: true };
  it('defaults to the type icon and follows the plan setting', () => {
    expect(seatPlanLabel(wc, {})).toEqual({ text: '♿', kind: 'MARKER' });
    expect(seatPlanLabel(comp, {})).toEqual({ text: '+', kind: 'MARKER' });
    expect(seatPlanLabel(wc, { wheelchairLabel: { mode: 'TEXT', text: 'R' } })?.text).toBe('R');
    expect(seatPlanLabel(comp, { companionLabel: { mode: 'NONE' } })).toBeNull();
    expect(seatPlanLabel(comp, { companionLabel: { mode: 'NUMBER' } })).toEqual({
      text: '2',
      kind: 'NUMBER',
    });
    expect(seatPlanLabel({ ...wc, isWheelchairSpace: false }, {})).toEqual({
      text: '1',
      kind: 'NUMBER',
    });
  });
});

describe('companion seats', () => {
  const seat = (
    id: string,
    position: number,
    kind: 'W' | 'C' | '-',
    companionOfSeatId: string | null = null,
  ) => ({
    id,
    parentId: 'row',
    position,
    isWheelchairSpace: kind === 'W',
    isCompanionSeat: kind === 'C',
    companionOfSeatId,
  });

  it('pairs companion seats with adjacent or explicitly assigned wheelchair spaces', () => {
    // C1 W2 W3 C4 - C6 (C6 assigned to W2 explicitly), C8 has no partner
    const partners = companionPartners([
      seat('C1', 1, 'C'),
      seat('W2', 2, 'W'),
      seat('W3', 3, 'W'),
      seat('C4', 4, 'C'),
      seat('S5', 5, '-'),
      seat('C6', 6, 'C', 'W2'),
      seat('C8', 8, 'C'),
    ]);
    expect(partners.get('C1')).toEqual(['W2']);
    expect(partners.get('C4')).toEqual(['W3']);
    expect(partners.get('C6')).toEqual(['W2']);
    expect(partners.has('C8')).toBe(false);
  });

  it('flags companion seats booked without their wheelchair space', () => {
    const seats = [
      { i: 'C1', w: ['W2'] },
      { i: 'W2' },
      { i: 'C8' }, // no partner → bookable alone
    ];
    expect(checkCompanionSeats(new Set(['C1']), seats).unpaired).toEqual(['C1']);
    expect(checkCompanionSeats(new Set(['C1', 'W2']), seats).unpaired).toEqual([]);
    expect(checkCompanionSeats(new Set(['C8']), seats).unpaired).toEqual([]);
    // wheelchair space already sold → allowed, owner (e-mail) verified at checkout
    expect(checkCompanionSeats(new Set(['C1']), seats, new Set(['W2']))).toEqual({
      unpaired: [],
      ownerCheck: ['C1'],
    });
  });
});

describe('best available', () => {
  const seat = (id: string, rowId: string, position: number, flags = 0): BestAvailableSeat => ({
    id,
    sectionId: 'sec',
    rowId,
    position,
    categoryId: 'cat',
    rank: null,
    flags,
  });
  const seats = [
    ...[1, 2, 3, 4, 5, 6].map((p) => seat(`A${p}`, 'A', p)),
    ...[1, 2, 3, 4, 5, 6].map((p) => seat(`B${p}`, 'B', p)),
  ];
  const base = {
    seats,
    sections: [{ id: 'sec', priority: 1, enabled: true }],
    rows: [
      { id: 'A', sortOrder: 1 },
      { id: 'B', sortOrder: 2 },
    ],
    categoryId: 'cat',
  };

  it('prefers the front row centre', () => {
    const [best] = findBestAvailable({ ...base, unavailable: new Set(), quantity: 2 });
    expect(best).toEqual({ ids: ['A3', 'A4'], arrangement: 'ROW' });
  });

  it('avoids stranding single seats when a better block exists', () => {
    const [best] = findBestAvailable({ ...base, unavailable: new Set(['A1']), quantity: 3 });
    // A3-A5 is more central but would strand A2
    expect(best?.ids).toEqual(['A2', 'A3', 'A4']);
  });

  it('never assigns wheelchair spaces automatically', () => {
    const wheelchair = seats.map((s) =>
      s.rowId === 'A' ? { ...s, flags: SEAT_FLAG.WHEELCHAIR } : s,
    );
    const [best] = findBestAvailable({
      ...base,
      seats: wheelchair,
      unavailable: new Set(),
      quantity: 2,
    });
    expect(best?.ids.every((id) => id.startsWith('B'))).toBe(true);
  });

  it('splits a group over consecutive rows when no row has enough seats side by side', () => {
    // 3 rows × 3 seats, 5 tickets → 3 + 2 one behind the other
    const grid: BestAvailableSeat[] = ['A', 'B', 'C'].flatMap((row, r) =>
      [1, 2, 3].map((p) => ({
        id: `${row}${p}`,
        sectionId: 'sec',
        rowId: row,
        position: p,
        categoryId: 'cat',
        rank: null,
        flags: 0,
        x: p * 20,
        y: r * 20,
      })),
    );
    const input = {
      seats: grid,
      sections: [{ id: 'sec', priority: 1, enabled: true }],
      rows: ['A', 'B', 'C'].map((id, i) => ({ id, sortOrder: i + 1 })),
      categoryId: 'cat',
      unavailable: new Set<string>(),
      quantity: 5,
    };
    const [best] = findBestAvailable(input);
    expect(best?.arrangement).toBe('ROWS');
    expect(best?.ids).toHaveLength(5);
    expect(best?.ids.filter((id) => id.startsWith('A'))).toHaveLength(3); // front row first
    expect(best?.ids.filter((id) => id.startsWith('B'))).toHaveLength(2);

    // rows A and C only (B sold out) are not consecutive → seats are picked scattered
    const sparse = findBestAvailable({
      ...input,
      unavailable: new Set(['B1', 'B2', 'B3']),
    });
    expect(sparse[0]?.arrangement).toBe('SCATTERED');
    expect(new Set(sparse[0]?.ids).size).toBe(5);
  });

  it('returns no candidates when there are not enough seats at all', () => {
    expect(findBestAvailable({ ...base, unavailable: new Set(), quantity: 20 })).toEqual([]);
  });

  it('uses both rows when one row is too short (7 of 2 × 6 seats)', () => {
    const [best] = findBestAvailable({ ...base, unavailable: new Set(), quantity: 7 });
    expect(best?.arrangement).toBe('ROWS');
    expect(best?.ids).toHaveLength(7);
  });
});

describe('pricing', () => {
  it('applies discount kinds', () => {
    expect(computeTicketPrice(3000, { discountKind: 'NONE', discountValue: 0 })).toEqual({
      unitPriceGross: 3000,
      discountAmount: 0,
      priceGross: 3000,
    });
    expect(
      computeTicketPrice(3000, { discountKind: 'PERCENT', discountValue: 2500 }).priceGross,
    ).toBe(2250);
    expect(
      computeTicketPrice(3000, { discountKind: 'FIXED_AMOUNT', discountValue: 5000 }).priceGross,
    ).toBe(0);
    expect(computeTicketPrice(3000, { discountKind: 'FIXED_PRICE', discountValue: 1500 })).toEqual({
      unitPriceGross: 3000,
      discountAmount: 1500,
      priceGross: 1500,
    });
    expect(computeTicketPrice(3000, { discountKind: 'NONE', discountValue: 0 }, 3500)).toEqual({
      unitPriceGross: 3500,
      discountAmount: 0,
      priceGross: 3500,
    });
  });

  it('applies per-category tariff overrides (Cat 1 −5 €, Cat 2 −4 €)', () => {
    const reduced = { discountKind: 'PERCENT' as const, discountValue: 1000 };
    expect(
      computeTicketPrice(5900, reduced, { discountKind: 'FIXED_AMOUNT', discountValue: 500 })
        .priceGross,
    ).toBe(5400);
    expect(
      computeTicketPrice(4500, reduced, { discountKind: 'FIXED_AMOUNT', discountValue: 400 })
        .priceGross,
    ).toBe(4100);
    // no override → tariff rule (−10 %)
    expect(computeTicketPrice(4500, reduced, { priceOverride: null }).priceGross).toBe(4050);
    // fixed price override wins
    expect(computeTicketPrice(4500, reduced, { priceOverride: 1990 }).priceGross).toBe(1990);
  });

  it('splits gross into net and tax', () => {
    expect(splitGross(3000, 700)).toEqual({ net: 2804, tax: 196 });
    expect(splitGross(1190, 1900)).toEqual({ net: 1000, tax: 190 });
    expect(splitGross(500, 0)).toEqual({ net: 500, tax: 0 });
  });
});

describe('geometry', () => {
  it('distributes seats evenly along a straight row', () => {
    const seats = layoutRowSeats(
      { type: 'straight', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
      5,
    );
    expect(seats.map((s) => s.x)).toEqual([0, 25, 50, 75, 100]);
  });

  it('orients seats along the row, turned or in a fixed direction', () => {
    const arc = {
      type: 'arc' as const,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      control: { x: 50, y: 40 },
    };
    const follow = layoutRowSeats(arc, 3);
    expect(follow[1]!.rotation).toBe(0); // middle of a symmetric arc faces straight up
    expect(follow[0]!.rotation).toBeGreaterThan(0); // left end turned towards the centre
    expect(follow[2]!.rotation).toBeLessThan(0);
    const turned = layoutRowSeats(arc, 3, { mode: 'ROW', angle: 180 });
    expect(turned[1]!.rotation).toBe(180);
    expect(turned[0]!.rotation).toBeCloseTo(orientSeat(follow[0]!.rotation + 180), 5);
    const fixed = layoutRowSeats(arc, 3, { mode: 'FIXED', angle: -90 });
    expect(fixed.map((p) => p.rotation)).toEqual([-90, -90, -90]);
    expect(orientSeat(350)).toBe(-10);
    expect(orientSeat(-190)).toBe(170);
    // tangent at an arbitrary seat position (e.g. after moving seats between rows)
    for (const seat of layoutRowSeats(arc, 9)) {
      expect(Math.abs(tangentAngleNear(arc, seat) - seat.rotation)).toBeLessThan(0.02);
    }
  });

  it('allows an unlimited ticket count per order (empty field = null)', () => {
    expect(parseSetting('checkout', { maxTicketsPerOrder: null }).maxTicketsPerOrder).toBeNull();
    expect(parseSetting('checkout', {}).maxTicketsPerOrder).toBe(10);
    expect(parseSetting('seatDisplay', {}).selectionStyle).toBe('RING');
  });

  it('validates the shop event grid size (default 3, 1..10)', () => {
    expect(parseSetting('shopLayout', {}).eventsPerRow).toBe(3);
    expect(parseSetting('shopLayout', { eventsPerRow: 6 }).eventsPerRow).toBe(6);
    // Older versions allowed up to 10: clamped to the new maximum instead of failing.
    expect(parseSetting('shopLayout', { eventsPerRow: 10 }).eventsPerRow).toBe(6);
    expect(() => parseSetting('shopLayout', { eventsPerRow: 0 })).toThrow();
    expect(() => parseSetting('shopLayout', { eventsPerRow: 2.5 })).toThrow();
  });

  it('places row labels next to a single seat (also on a zero-length row)', () => {
    const seat = { x: 100, y: 50 };
    const point = { type: 'straight' as const, start: seat, end: seat };
    const a = rowLabelAnchors(point, 20, { first: seat, last: seat });
    expect(a.start).toEqual({ x: 80, y: 50 });
    expect(a.end).toEqual({ x: 120, y: 50 });
    // single seat in the middle of a longer row: labels hug the seat, not the curve ends
    const row = { type: 'straight' as const, start: { x: 0, y: 50 }, end: { x: 200, y: 50 } };
    const b = rowLabelAnchors(row, 20, { first: seat, last: seat });
    expect(b.start.x).toBe(80);
    expect(b.end.x).toBe(120);
  });

  it('centres symbol and label of an element as one group', () => {
    const layout = elementLayout({
      type: 'STAGE',
      geometry: { type: 'rect', x: 0, y: 0, width: 200, height: 100, rotation: 0, cornerRadius: 0 },
      label: 'STAGE',
      style: { symbolId: '00000000-0000-4000-8000-000000000000', symbolSize: 40, fontSize: 20 },
    });
    const top = layout.symbol!.cy - 40 / 2;
    const bottom = layout.text!.cy + 20 / 2;
    expect(layout.symbol!.cx).toBe(100);
    expect(layout.text!.cx).toBe(100);
    expect((top + bottom) / 2).toBeCloseTo(50, 6); // group centred vertically
    expect(layout.textColor).toBe('#ffffff'); // contrast on the dark default stage fill
    const custom = elementLayout({
      type: 'STAGE',
      geometry: { type: 'rect', x: 0, y: 0, width: 200, height: 100, rotation: 0, cornerRadius: 0 },
      label: 'STAGE',
      style: { textColor: '#ff0000', symbolColor: '#00ff00' },
    });
    expect([custom.textColor, custom.symbolColor]).toEqual(['#ff0000', '#00ff00']);
  });

  it('numbers seats odd/even from the centre', () => {
    expect(seatNumbers(5, 'ODD_EVEN_FROM_CENTER')).toEqual(['5', '3', '1', '2', '4']);
    expect(seatNumbers(3, 'DESCENDING')).toEqual(['3', '2', '1']);
  });
});

describe('seat map document', () => {
  const sectionId = '00000000-0000-4000-8000-000000000001';
  const rowId = '00000000-0000-4000-8000-000000000002';
  const doc = {
    version: 1,
    name: 'Hall',
    canvasWidth: 1000,
    canvasHeight: 800,
    sections: [
      {
        id: sectionId,
        type: 'SEATED',
        name: 'Stalls',
        ticketLabel: 'Stalls',
        geometry: { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
      },
    ],
    rows: [
      {
        id: rowId,
        sectionId,
        label: 'A',
        geometry: {
          curve: { type: 'straight', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
          seatSpacing: 5,
        },
      },
    ],
    seats: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        sectionId,
        rowId,
        label: '1',
        position: 1,
        x: 0,
        y: 0,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        sectionId,
        rowId,
        label: '1',
        position: 1,
        x: 5,
        y: 0,
      },
    ],
  };

  it('reports duplicate seat numbers and positions', () => {
    const result = seatMapDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((i) => i.message);
    expect(messages).toContain('Duplicate position');
    expect(messages).toContain('Duplicate seat number in row');
  });
});

describe('signed tokens', () => {
  const secret = 'x'.repeat(40);

  it('verifies purpose, signature and expiry', () => {
    const token = signToken('cart', { sid: 'abc' }, 60, secret);
    expect(verifyToken<{ sid: string }>(token, 'cart', secret)?.sid).toBe('abc');
    expect(verifyToken(token, 'queue-pass', secret)).toBeNull();
    expect(verifyToken(token, 'cart', 'y'.repeat(40))).toBeNull();
    expect(verifyToken(signToken('cart', {}, -1, secret), 'cart', secret)).toBeNull();
    expect(verifyToken(`${token}x`, 'cart', secret)).toBeNull();
  });
});
