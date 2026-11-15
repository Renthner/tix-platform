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
    expect(nav.move('a3', 'right')).toBeNull();
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
});
