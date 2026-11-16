import { describe, expect, it } from 'vitest';
import { EVENT_FILE_MAX_BYTES, eventFileSchema } from '@tix/shared';
import { DomainError, parseEventFile } from '../src';

const minimal = () => ({
  format: 'tix-event',
  version: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  source: { appVersion: 'x' },
  event: {
    title: 'Show',
    timeZone: 'Europe/Berlin',
    currency: 'EUR',
    taxRate: { name: 'VAT', rateBasisPoints: 1900 },
    startsAt: '2026-06-01T18:00:00.000Z',
  },
});
const text = (value: unknown) => JSON.stringify(value);
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof DomainError ? err.code : 'OTHER';
  }
  return undefined;
};

describe('event file parsing', () => {
  it('accepts a minimal file and fills defaults', () => {
    const file = parseEventFile(text(minimal()));
    expect(file.priceCategories).toEqual([]);
    expect(file.seatPlan).toBeNull();
    expect(file.event.infoBoxes).toEqual([]);
  });

  it('rejects non-JSON, foreign formats and unsupported versions', () => {
    expect(code(() => parseEventFile('not json'))).toBe('EVENT_FILE_INVALID');
    expect(code(() => parseEventFile(text({ ...minimal(), format: 'tix-seatmap' })))).toBe(
      'EVENT_FILE_INVALID',
    );
    expect(code(() => parseEventFile(text(null)))).toBe('EVENT_FILE_INVALID');
    expect(code(() => parseEventFile(text({ ...minimal(), version: 99 })))).toBe(
      'EVENT_VERSION_UNSUPPORTED',
    );
  });

  it('rejects oversized files', () => {
    expect(code(() => parseEventFile(Buffer.alloc(EVENT_FILE_MAX_BYTES + 1, 32)))).toBe(
      'EVENT_FILE_TOO_LARGE',
    );
  });

  const invalid = (patch: (f: ReturnType<typeof minimal> & Record<string, unknown>) => void) => {
    const file = minimal() as ReturnType<typeof minimal> & Record<string, unknown>;
    patch(file);
    expect(code(() => parseEventFile(text(file)))).toBe('EVENT_FILE_INVALID');
  };

  it('rejects inconsistent dates and unknown time zones / currencies', () => {
    invalid((f) => Object.assign(f.event, { endsAt: '2026-06-01T17:00:00.000Z' }));
    invalid((f) => Object.assign(f.event, { doorsOpenAt: '2026-06-01T19:00:00.000Z' }));
    invalid((f) =>
      Object.assign(f.event, {
        presaleStartsAt: '2026-05-02T00:00:00.000Z',
        publicSaleStartsAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    invalid((f) =>
      Object.assign(f.event, {
        publicSaleStartsAt: '2026-05-02T00:00:00.000Z',
        saleEndsAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    invalid((f) => Object.assign(f.event, { timeZone: 'Mars/Base' }));
    invalid((f) => Object.assign(f.event, { currency: 'euro' }));
    invalid((f) => Object.assign(f.event, { startsAt: 'tomorrow' }));
  });

  it('rejects invalid overrides and unknown enum values', () => {
    invalid((f) => Object.assign(f.event, { maxTicketsPerOrder: 0 }));
    invalid((f) => Object.assign(f.event, { cartLockTtlSeconds: -5 }));
    invalid((f) => Object.assign(f.event, { waitlistTrigger: 'ALWAYS' }));
  });

  const category = { key: 'c1', name: 'A', color: '#112233', basePrice: 1000 };
  const type = { key: 't1', name: 'Normal' };

  it('rejects broken references and duplicates', () => {
    invalid((f) =>
      Object.assign(f, {
        priceCategories: [category],
        ticketTypes: [type],
        pricing: [{ categoryKey: 'c9', typeKey: 't1' }],
      }),
    );
    invalid((f) => Object.assign(f, { priceCategories: [category, { ...category, key: 'c2' }] }));
    invalid((f) => Object.assign(f, { priceCategories: [category, category] }));
    invalid((f) =>
      Object.assign(f, {
        ticketTypes: [
          { ...type, isDefault: true },
          { key: 't2', name: 'B', isDefault: true },
        ],
      }),
    );
    invalid((f) =>
      Object.assign(f, {
        priceCategories: [category],
        ticketTypes: [type],
        pricing: [
          {
            categoryKey: 'c1',
            typeKey: 't1',
            priceOverride: 100,
            discountKind: 'PERCENT',
            discountValue: 5,
          },
        ],
      }),
    );
    invalid((f) =>
      Object.assign(f, {
        priceCategories: [category],
        ticketTypes: [type],
        pricing: [{ categoryKey: 'c1', typeKey: 't1', discountKind: 'PERCENT' }],
      }),
    );
    invalid((f) => Object.assign(f.event, { heroImageKey: 'nope' }));
    invalid((f) => Object.assign(f.event, { ticketTemplateKey: 'nope' }));
    invalid((f) =>
      Object.assign(f.event, {
        infoBoxes: [{ key: 'b1', title: 'x', content: '', symbolKey: 'nope' }],
      }),
    );
  });

  it('rejects a tariff that requires a proof without a warning text', () => {
    invalid((f) => Object.assign(f, { ticketTypes: [{ ...type, requiresProofAtEntry: true }] }));
  });

  it('rejects a seat plan with categories that are not price categories of the file', () => {
    const plan = {
      format: 'tix-seatmap',
      version: 2,
      exportedAt: '',
      source: { appVersion: 'x' },
      plan: { name: 'P', canvasWidth: 1000, canvasHeight: 800 },
      categories: [{ key: 'cat1', name: 'Missing', color: '#112233' }],
    };
    invalid((f) => Object.assign(f, { seatPlan: plan }));
    expect(
      eventFileSchema.safeParse({
        ...minimal(),
        seatPlan: plan,
        priceCategories: [{ ...category, name: 'Missing' }],
      }).success,
    ).toBe(true);
  });
});
