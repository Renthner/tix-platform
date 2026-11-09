import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { moveItem, shopOrderInputSchema, sortShopEvents } from '../src/shop-order';

const ev = (id: string, day: number, order: number | null) => ({
  id,
  startsAt: new Date(2030, 0, day),
  shopSortOrder: order,
});

describe('sortShopEvents', () => {
  it('puts placed events first by order, then unplaced by date', () => {
    const list = [ev('a', 1, null), ev('b', 9, 1), ev('c', 5, 0), ev('d', 2, null)];
    expect(sortShopEvents(list).map((e) => e.id)).toEqual(['c', 'b', 'a', 'd']);
  });
  it('does not mutate the input', () => {
    const list = [ev('a', 2, null), ev('b', 1, null)];
    sortShopEvents(list);
    expect(list[0]!.id).toBe('a');
  });
});

describe('moveItem', () => {
  it('moves and ignores out-of-range', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
});

describe('shopOrderInputSchema', () => {
  it('accepts distinct uuids', () => {
    expect(shopOrderInputSchema.safeParse([randomUUID(), randomUUID()]).success).toBe(true);
  });
  it('rejects duplicates and non-uuids', () => {
    const id = randomUUID();
    expect(shopOrderInputSchema.safeParse([id, id]).success).toBe(false);
    expect(shopOrderInputSchema.safeParse(['x']).success).toBe(false);
    expect(shopOrderInputSchema.safeParse('nope').success).toBe(false);
  });
});
