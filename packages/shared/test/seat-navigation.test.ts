import { describe, expect, it } from 'vitest';
import { createSeatNavigator } from '../src/seating/navigation';

const seat = (i: string, s: string, r: string | null, p: number | null, x: number, y: number) => ({
  i,
  s,
  r,
  p,
  x,
  y,
});

// Section A: row 1 (y=0) has 3 seats, row 2 (y=20) has 4 seats offset by half a seat; row 3 is
// numbered right to left. Section B has one row.
const seats = [
  seat('a1', 'A', 'r1', 1, 0, 0),
  seat('a2', 'A', 'r1', 2, 20, 0),
  seat('a3', 'A', 'r1', 3, 40, 0),
  seat('b1', 'A', 'r2', 1, -10, 20),
  seat('b2', 'A', 'r2', 2, 10, 20),
  seat('b3', 'A', 'r2', 3, 30, 20),
  seat('b4', 'A', 'r2', 4, 50, 20),
  seat('c1', 'A', 'r3', 1, 40, 40),
  seat('c2', 'A', 'r3', 2, 20, 40),
  seat('c3', 'A', 'r3', 3, 0, 40),
  seat('d1', 'B', 'r4', 1, 200, 0),
  seat('d2', 'B', 'r4', 2, 220, 0),
  seat('g1', 'C', null, null, 400, 5),
  seat('g2', 'C', null, null, 380, 5),
];
const nav = createSeatNavigator(seats, ['A', 'B', 'C']);

describe('seat navigation', () => {
  it('moves left / right within a row and stops at the ends', () => {
    expect(nav.move('a1', 'right')).toBe('a2');
    expect(nav.move('a2', 'left')).toBe('a1');
    expect(nav.move('a1', 'left')).toBeNull();
    expect(nav.move('c1', 'right')).toBe('d1'); // end of the section: continues into the next block
    expect(nav.move('a1', 'left')).toBeNull(); // nothing further left
  });

  it('follows the screen direction when a row is numbered right to left', () => {
    expect(nav.move('c3', 'right')).toBe('c2');
    expect(nav.move('c1', 'left')).toBe('c2');
    expect(nav.move('c3', 'home')).toBe('c3');
    expect(nav.move('c3', 'end')).toBe('c1');
  });

  it('goes up and down to the nearest seat by x', () => {
    expect(nav.move('a1', 'down')).toBe('b1'); // x 0 -> -10 / 10 tie resolves to the first
    expect(nav.move('a3', 'down')).toBe('b3'); // x 40 -> 30 or 50 (first wins)
    expect(nav.move('b4', 'up')).toBe('a3');
    expect(nav.move('b1', 'down')).toBe('c3');
    expect(nav.move('a2', 'up')).toBeNull();
    expect(nav.move('c1', 'down')).toBeNull();
  });

  it('jumps to row start / end', () => {
    expect(nav.move('b2', 'home')).toBe('b1');
    expect(nav.move('b2', 'end')).toBe('b4');
  });

  it('moves between sections with PageUp / PageDown', () => {
    expect(nav.move('b3', 'pageDown')).toBe('d1');
    expect(nav.move('d2', 'pageUp')).toBe('a1');
    expect(nav.move('d2', 'pageDown')).toBe('g2');
    expect(nav.move('a1', 'pageUp')).toBeNull();
    expect(nav.sections).toEqual(['A', 'B', 'C']);
  });

  it('orders seats without a row by x', () => {
    expect(nav.move('g2', 'right')).toBe('g1');
  });

  it('returns null for unknown seats', () => {
    expect(nav.move('nope', 'left')).toBeNull();
  });

  it('first / last jump to the ends of the whole plan', () => {
    expect(nav.move('d1', 'first')).toBe('a1');
    expect(nav.move('a1', 'last')).toBe('g1');
  });
});

describe('seat navigation across sections', () => {
  const row = (s: string, r: string, n: number, x0: number, y0: number, dx = 20, dy = 0) =>
    Array.from({ length: n }, (_, k) =>
      seat(`${r}${k + 1}`, s, r, k + 1, x0 + k * dx, y0 + k * dy),
    );

  it('two blocks side by side: right / left cross the gap, rows stay aligned', () => {
    const n = createSeatNavigator(
      [...row('L', 'l1', 3, 0, 0), ...row('L', 'l2', 3, 0, 20), ...row('R', 'r1', 3, 200, 0)],
      ['L', 'R'],
    );
    expect(n.move('l13', 'right')).toBe('r11');
    expect(n.move('l23', 'right')).toBe('r11'); // row 2 has no partner: nearest in the cone
    expect(n.move('r11', 'left')).toBe('l13');
  });

  it('blocks above / below, tolerant of an offset', () => {
    const n = createSeatNavigator(
      [...row('T', 't1', 3, 100, 0), ...row('B', 'b1', 3, 160, 100)],
      ['T', 'B'],
    );
    expect(n.move('t13', 'down')).toBe('b11'); // x 140 -> nearest straight below is 160
    expect(n.move('t11', 'down')).toBe('b11'); // still inside the cone
    expect(n.move('b13', 'up')).toBe('t13');
    expect(n.move('t11', 'up')).toBeNull();
  });

  it('ignores sections that are not in the direction', () => {
    const n = createSeatNavigator(
      [...row('L', 'l1', 2, 0, 0), ...row('R', 'r1', 2, 100, 400)],
      ['L', 'R'],
    );
    expect(n.move('l12', 'right')).toBeNull(); // far below, outside the 60 degree cone
    expect(n.move('l12', 'down')).toBe('r11');
  });

  it('works with curved rows (seats on an arc)', () => {
    const arc = Array.from({ length: 5 }, (_, k) => {
      const a = Math.PI * (0.25 + 0.125 * k);
      return seat(`c${k + 1}`, 'ARC', 'c', k + 1, 300 + 200 * Math.cos(a), 200 * Math.sin(a));
    });
    const n = createSeatNavigator([...arc, ...row('S', 's1', 3, 0, 100)], ['S', 'ARC']);
    expect(n.move('s13', 'right')).toBe('c5'); // leftmost seat of the arc
    expect(n.move('c5', 'left')).toBe('s13');
    expect(n.move('c1', 'right')).toBeNull();
  });

  it('a section with a single seat is reachable and leaves again', () => {
    const n = createSeatNavigator(
      [
        ...row('A', 'a1', 2, 0, 0),
        seat('x1', 'ONE', null, null, 100, 0),
        ...row('C', 'c1', 2, 200, 0),
      ],
      ['A', 'ONE', 'C'],
    );
    expect(n.move('a12', 'right')).toBe('x1');
    expect(n.move('x1', 'right')).toBe('c11');
    expect(n.move('x1', 'left')).toBe('a12');
    expect(n.move('x1', 'up')).toBeNull();
  });

  it('empty sections do not exist for navigation', () => {
    const n = createSeatNavigator([...row('A', 'a1', 2, 0, 0)], ['EMPTY', 'A']);
    expect(n.sections).toEqual(['A']);
    expect(n.move('a12', 'right')).toBeNull();
    expect(n.move('a11', 'pageUp')).toBeNull();
  });
});
