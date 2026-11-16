import { describe, expect, it } from 'vitest';
import {
  SEAT_FLAG,
  computeWaitlistCategoryStates,
  decideWaitlistOffer,
  type WaitlistCategoryState,
  type WaitlistInventory,
} from '../src';

const seat = (i: string, c: string | null, f = 0) => ({ i, c, f });
const map = (seats: ReturnType<typeof seat>[], sections: unknown[] = []) =>
  ({
    categories: [{ id: 'A' }, { id: 'B' }],
    seats,
    sections,
  }) as unknown as Parameters<typeof computeWaitlistCategoryStates>[0];
const inv = (p: Partial<WaitlistInventory> = {}): WaitlistInventory => ({
  taken: new Set(),
  held: new Set(),
  ga: {},
  ...p,
});
const state = (
  id: string,
  capacity: number,
  free: number,
  held: number,
): WaitlistCategoryState => ({
  id,
  capacity,
  free,
  held,
});

describe('computeWaitlistCategoryStates', () => {
  it('counts free, held and sold seats per category and skips blocked seats', () => {
    const states = computeWaitlistCategoryStates(
      map([
        seat('1', 'A'),
        seat('2', 'A'),
        seat('3', 'A'),
        seat('4', 'A', SEAT_FLAG.BLOCKED),
        seat('5', 'B'),
        seat('6', null),
      ]),
      inv({ taken: new Set(['1']), held: new Set(['2', '5']) }),
    );
    expect(states).toEqual([state('A', 3, 1, 1), state('B', 1, 0, 1)]);
  });

  it('a seat that is both held and sold counts as sold', () => {
    const [a] = computeWaitlistCategoryStates(
      map([seat('1', 'A')]),
      inv({ taken: new Set(['1']), held: new Set(['1']) }),
    );
    expect(a).toEqual(state('A', 1, 0, 0));
  });

  it('derives standing area holds from remaining versus sellable spots', () => {
    const sections = [{ id: 'S', type: 'STANDING', priceCategoryId: 'A' }];
    expect(
      computeWaitlistCategoryStates(map([], sections), inv({ ga: { S: 0 }, gaOpen: { S: 3 } }))[0],
    ).toEqual(state('A', 3, 0, 3));
    // Sold out standing area: still offered, nothing held.
    expect(
      computeWaitlistCategoryStates(map([], sections), inv({ ga: { S: 0 }, gaOpen: { S: 0 } }))[0],
    ).toEqual(state('A', 1, 0, 0));
    // Unknown sellable capacity: nothing is assumed to be held.
    expect(computeWaitlistCategoryStates(map([], sections), inv({ ga: { S: 2 } }))[0]).toEqual(
      state('A', 2, 2, 0),
    );
  });
});

describe('decideWaitlistOffer', () => {
  it('shows nothing while a ticket is free', () => {
    const states = [state('A', 2, 1, 0), state('B', 2, 0, 0)];
    expect(decideWaitlistOffer(states, 'WHEN_SOLD_OUT')).toEqual({
      soldOut: false,
      categoryIds: ['B'],
    });
    expect(decideWaitlistOffer([state('A', 2, 1, 0)], 'WHEN_UNAVAILABLE')).toBeNull();
  });

  it('WHEN_UNAVAILABLE offers as soon as nothing can be selected', () => {
    const states = [state('A', 2, 0, 2), state('B', 2, 0, 1)];
    expect(decideWaitlistOffer(states, 'WHEN_UNAVAILABLE')).toEqual({
      soldOut: true,
      categoryIds: ['A', 'B'],
    });
  });

  it('WHEN_SOLD_OUT waits while tickets are merely held in carts', () => {
    expect(
      decideWaitlistOffer([state('A', 2, 0, 2), state('B', 2, 0, 1)], 'WHEN_SOLD_OUT'),
    ).toBeNull();
    // Category B is really out, A is only held: B is offered, the event is not out.
    expect(
      decideWaitlistOffer([state('A', 2, 0, 1), state('B', 2, 0, 0)], 'WHEN_SOLD_OUT'),
    ).toEqual({
      soldOut: false,
      categoryIds: ['B'],
    });
  });

  it('WHEN_SOLD_OUT with everything sold offers the whole event once', () => {
    expect(
      decideWaitlistOffer([state('A', 2, 0, 0), state('B', 2, 0, 0)], 'WHEN_SOLD_OUT'),
    ).toEqual({
      soldOut: true,
      categoryIds: ['A', 'B'],
    });
  });

  it('ignores categories nothing is sold in', () => {
    expect(
      decideWaitlistOffer([state('A', 2, 1, 0), state('B', 0, 0, 0)], 'WHEN_UNAVAILABLE'),
    ).toBeNull();
  });
});
