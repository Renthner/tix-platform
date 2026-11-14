import type { SaleState } from '@tix/core';

/** `2026-11-13T20:00:00+01:00` – the instant rendered in `timeZone` with its UTC offset. */
export function isoWithOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const raw = get('timeZoneName'); // "GMT", "GMT+01:00", "GMT-03:30"
  const offset = raw === 'GMT' ? '+00:00' : raw.replace('GMT', '');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

const EVENT_STATUS: Record<string, string> = {
  PUBLISHED: 'EventScheduled',
  POSTPONED: 'EventPostponed',
  CANCELLED: 'EventCancelled',
};

function availability(state: SaleState): string {
  switch (state) {
    case 'ON_SALE':
      return 'InStock';
    case 'PRESALE':
    case 'NOT_STARTED':
      return 'PreOrder';
    case 'ENDED':
      // The sale is over; that says nothing about remaining stock, so not `SoldOut`.
      return 'Discontinued';
    default:
      return 'OutOfStock';
  }
}

export interface EventJsonLdInput {
  url: string;
  name: string;
  description?: string;
  status: string;
  saleState: SaleState;
  startsAt: Date;
  endsAt: Date | null;
  doorsOpenAt: Date | null;
  timeZone: string;
  currency: string;
  /**
   * Lowest / highest price a customer can pay in minor units (active categories × offered
   * general tariffs, see `publicPriceRanges`); null = nothing sellable.
   */
  priceRange: { min: number; max: number } | null;
  saleOpensAt: Date | null;
  images: string[];
  venue: {
    name: string;
    street: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
    latitude: number | null;
    longitude: number | null;
    websiteUrl: string | null;
  };
  organizer: { name?: string; url?: string };
}

/** schema.org `Event` (Google rich results) for a shop-visible event. */
export function buildEventJsonLd(i: EventJsonLdInput): Record<string, unknown> {
  const v = i.venue;
  const hasAddress = v.street || v.postalCode || v.city || v.country;
  const money = (minor: number) => (minor / 100).toFixed(2);
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: i.name,
    ...(i.description && { description: i.description }),
    startDate: isoWithOffset(i.startsAt, i.timeZone),
    ...(i.endsAt && { endDate: isoWithOffset(i.endsAt, i.timeZone) }),
    ...(i.doorsOpenAt && { doorTime: isoWithOffset(i.doorsOpenAt, i.timeZone) }),
    eventStatus: `https://schema.org/${EVENT_STATUS[i.status] ?? 'EventScheduled'}`,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: v.name,
      ...(hasAddress && {
        address: {
          '@type': 'PostalAddress',
          ...(v.street && { streetAddress: v.street }),
          ...(v.postalCode && { postalCode: v.postalCode }),
          ...(v.city && { addressLocality: v.city }),
          ...(v.country && { addressCountry: v.country }),
        },
      }),
      ...(v.latitude !== null &&
        v.longitude !== null && {
          geo: { '@type': 'GeoCoordinates', latitude: v.latitude, longitude: v.longitude },
        }),
      ...(v.websiteUrl && { url: v.websiteUrl }),
    },
    ...(i.images.length > 0 && { image: i.images }),
    ...(i.organizer.name && {
      organizer: {
        '@type': 'Organization',
        name: i.organizer.name,
        ...(i.organizer.url && { url: i.organizer.url }),
      },
    }),
    ...(i.priceRange && {
      offers: {
        '@type': 'AggregateOffer',
        url: i.url,
        priceCurrency: i.currency,
        lowPrice: money(i.priceRange.min),
        highPrice: money(i.priceRange.max),
        availability: `https://schema.org/${availability(i.saleState)}`,
        ...(i.saleOpensAt && { validFrom: isoWithOffset(i.saleOpensAt, i.timeZone) }),
      },
    }),
  };
}

/** JSON for an inline `<script type="application/ld+json">`: `<` escaped so it cannot close the tag. */
export function jsonLdString(data: unknown): string {
  const escape = (c: string) =>
    `${String.fromCharCode(92)}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  // `<` (script end tag / comment openers) and the JS line terminators U+2028 / U+2029.
  return JSON.stringify(data).replace(
    new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g'),
    escape,
  );
}
