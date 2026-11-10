import { describe, expect, it } from 'vitest';
import { boxOfficeSellSchema, normalizeBuyerLocale } from '../src/orders/box-office';

const uuid = () => crypto.randomUUID();

/** Exactly the body `box-office.tsx` builds in `sell()` for a seat sale with nothing filled in. */
function uiPayload(overrides: Record<string, unknown> = {}) {
  return {
    lines: [{ eventId: uuid(), seatId: uuid(), ticketTypeId: uuid() }],
    payment: 'CASH',
    allowBlocked: false,
    locale: 'de-DE', // shop default language as stored in the general settings
    tabId: uuid(),
    sendEmail: false,
    note: undefined,
    priceOverrideReason: undefined,
    buyer: { firstName: '', lastName: '', email: '', phone: '', company: '' },
    ...overrides,
  };
}

describe('box office sell payload', () => {
  it('accepts the UI payload with a regional default locale (de-DE) and empty buyer fields', () => {
    // JSON round trip drops undefined keys like fetch does.
    const body = JSON.parse(JSON.stringify(uiPayload()));
    const parsed = boxOfficeSellSchema.parse(body);
    expect(parsed.locale).toBe('de');
    expect(parsed.buyer?.email).toBeUndefined();
  });

  it('accepts standing lines, overrides, a filled address and plain locales', () => {
    const body = JSON.parse(
      JSON.stringify(
        uiPayload({
          locale: 'en',
          lines: [
            { eventId: uuid(), sectionId: uuid(), quantity: 2, ticketTypeId: uuid() },
            { eventId: uuid(), seatId: uuid(), ticketTypeId: uuid(), priceOverrideCents: 500 },
          ],
          priceOverrideReason: 'Volunteer',
          buyer: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'Ada@Example.com',
            phone: '',
            company: '',
            address: { street: 'Main 1', postalCode: '12345', city: 'Town', country: 'DE' },
          },
        }),
      ),
    );
    const parsed = boxOfficeSellSchema.parse(body);
    expect(parsed.locale).toBe('en');
    expect(parsed.buyer?.email).toBe('ada@example.com');
  });

  it('normalises locale tags', () => {
    expect(normalizeBuyerLocale('de-DE')).toBe('de');
    expect(normalizeBuyerLocale('en-GB')).toBe('en');
    expect(normalizeBuyerLocale('fr')).toBe('en');
    expect(normalizeBuyerLocale(undefined)).toBeUndefined();
  });
});
