import { describe, expect, it } from 'vitest';
import { publicPriceRanges, type PublicSeatMap } from '../src';

const category = (id: string, basePrice: number) =>
  ({ id, name: id, color: '#000', basePrice, sortOrder: 0, maxPerOrder: null }) as const;
const tariff = (
  id: string,
  prices: Record<string, number>,
  requiredSeatFeature: 'WHEELCHAIR_SPACE' | null = null,
) =>
  ({
    id,
    name: id,
    description: null,
    isDefault: false,
    requiresProofAtEntry: false,
    requiredSeatFeature,
    maxPerOrder: null,
    sortOrder: 0,
    prices,
  }) as const;

const map = (
  categories: ReturnType<typeof category>[],
  ticketTypes: ReturnType<typeof tariff>[],
): Pick<PublicSeatMap, 'categories' | 'ticketTypes'> => ({
  categories: categories.map((c) => ({ ...c })),
  ticketTypes: ticketTypes.map((t) => ({ ...t })),
});

describe('publicPriceRanges', () => {
  it('spans active categories x general tariffs and ignores seat-bound tariffs', () => {
    const r = publicPriceRanges(
      map(
        [category('c1', 5000), category('c2', 3000)],
        [
          tariff('full', { c1: 5000, c2: 3000 }),
          tariff('reduced', { c1: 4500, c2: 2600 }),
          tariff('wheelchair', { c1: 100, c2: 100 }, 'WHEELCHAIR_SPACE'),
        ],
      ),
    );
    expect(r.byCategory.get('c1')).toEqual({ min: 4500, max: 5000 });
    expect(r.byCategory.get('c2')).toEqual({ min: 2600, max: 3000 });
    expect(r.overall).toEqual({ min: 2600, max: 5000 });
  });

  it('falls back to the base price without matrix prices and to null without categories', () => {
    const r = publicPriceRanges(map([category('c1', 4200)], []));
    expect(r.overall).toEqual({ min: 4200, max: 4200 });
    expect(publicPriceRanges(map([], [])).overall).toBeNull();
  });
});
