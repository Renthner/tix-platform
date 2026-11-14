import type { Translations } from '../translations';
import type { SeatFeature, SectionType, SeatMapElementType } from '../enums';
import type {
  ElementGeometry,
  ElementStyle,
  RowGeometry,
  SeatMapSettingsInput,
  SectionGeometry,
  SectionLabel,
} from '../schemas/seat-map';

/**
 * Public, cacheable representation of an event's seating plan (no availability).
 * Cached per (event, seat map version); availability is fetched / streamed separately.
 */

/** Seat flags bitmask. */
export const SEAT_FLAG = {
  WHEELCHAIR: 1,
  COMPANION: 2,
  RESTRICTED_VIEW: 4,
  BLOCKED: 8,
} as const;

export interface PublicCategory {
  id: string;
  name: string;
  color: string;
  basePrice: number;
  sortOrder: number;
  /** Max. tickets of this category per order (null = no category limit). */
  maxPerOrder: number | null;
  /** Offered in best-available booking (the operator can switch it off per category). */
  bestAvailable: boolean;
  tr?: Translations;
}

export interface PublicTicketType {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  requiresProofAtEntry: boolean;
  requiredSeatFeature: SeatFeature | null;
  maxPerOrder: number | null;
  sortOrder: number;
  tr?: Translations;
  /** Final gross price (cents) per price category id where this tariff is offered. */
  prices: Record<string, number>;
}

export interface PublicSection {
  id: string;
  type: SectionType;
  name: string;
  ticketLabel: string;
  geometry: SectionGeometry;
  label: SectionLabel | null;
  color: string | null;
  priceCategoryId: string | null;
  isBestAvailableEnabled: boolean;
  /** Lower = preferred by best-available. */
  bestAvailablePriority: number;
  /** Whether the block name is drawn on the chart. */
  showNameOnMap: boolean;
  /** Whether the ticket label is shown in the cart / printed on tickets. */
  showLabelOnTicket: boolean;
  tr?: Translations;
}

export interface PublicRow {
  id: string;
  sectionId: string;
  label: string;
  /** Front-to-back rank used by best-available. */
  sortOrder: number;
  geometry: RowGeometry;
}

export interface PublicElement {
  id: string;
  type: SeatMapElementType;
  label: string | null;
  geometry: ElementGeometry;
  style: ElementStyle;
  zIndex: number;
  tr?: Translations;
}

export interface PublicEntrance {
  id: string;
  name: string;
  code: string;
  x: number;
  y: number;
  tr?: Translations;
}

/**
 * Version of the PublicSeatMap payload shape. Part of the snapshot cache key – BUMP IT whenever
 * fields are added / changed, otherwise a deploy keeps serving cached snapshots of the old
 * shape for up to an hour. (3: companion seat partners `w`; 4: category `maxPerOrder`; 5: content translations `tr`; 6: category `bestAvailable`.)
 */
export const PUBLIC_MAP_FORMAT = 6;

/** Compact seat (thousands per map): short keys keep the payload small. */
export interface PublicSeat {
  /** id */ i: string;
  /** section id */ s: string;
  /** row id */ r: string | null;
  /** table element id */ t: string | null;
  /** label (seat number) */ l: string;
  /** adjacency position */ p: number | null;
  x: number;
  y: number;
  /** rotation (deg) */ o: number;
  /** price category id */ c: string | null;
  /** best-available rank (lower = better) */ k: number | null;
  /** SEAT_FLAG bitmask */ f: number;
  /** custom seat symbol id (falls back to the map default) */ m: string | null;
  /** companion seats only: wheelchair space(s) this seat belongs to */ w?: string[];
}

/** SVG symbol (seat shape or element icon) referenced by the plan. */
export interface PublicSymbol {
  id: string;
  viewBox: string;
  /** Sanitised inner SVG markup (no <svg> wrapper). */
  markup: string;
  /** true → fills/strokes use currentColor and follow the seat / element colour. */
  colorize: boolean;
}

export interface PublicSeatMap {
  eventId: string;
  version: number;
  canvasWidth: number;
  canvasHeight: number;
  settings: SeatMapSettingsInput;
  backgroundUrl: string | null;
  currency: string;
  categories: PublicCategory[];
  ticketTypes: PublicTicketType[];
  sections: PublicSection[];
  rows: PublicRow[];
  elements: PublicElement[];
  entrances: PublicEntrance[];
  seats: PublicSeat[];
  /** Symbols referenced by seats, elements or the map default. */
  symbols: PublicSymbol[];
}

/** Dynamic availability of one event from the perspective of one cart session. */
export interface EventAvailability {
  eventId: string;
  /** Server time (epoch ms) of the snapshot. */
  at: number;
  /** Seat map version – clients reload the map when it differs. */
  version: number;
  /** Sold / reserved seats. */
  taken: string[];
  /** Seats locked in other customers' carts. */
  locked: string[];
  /** Seats locked in this session's cart. */
  mine: string[];
  /** Remaining spots per STANDING section (capacity − sold − held in carts). */
  ga: Record<string, number>;
  /** Spots this session holds per STANDING section. */
  gaMine: Record<string, number>;
}

/** Status codes in real-time seat deltas. */
export type SeatDeltaStatus = 'F' | 'L' | 'S' | 'B';

/** Message broadcast to all clients of an event (batched by the realtime service). */
export interface SeatDeltaMessage {
  eventId: string;
  /** [seatId, status] pairs: F = free, L = locked, S = sold/reserved, B = blocked. */
  seats: [string, SeatDeltaStatus][];
  /** Remaining GA capacity per section that changed. */
  ga?: Record<string, number>;
  /** New seat map version (clients reload the plan). */
  version?: number;
}

export interface PriceRange {
  min: number;
  max: number;
}

/**
 * Customer price range (gross, minor units) per active category over the general tariffs
 * offered there (reduced … full; wheelchair / companion tariffs are bound to special seats and
 * left out), plus the overall range of the event. A category without any matrix price falls back
 * to its base price. Shared by the category dropdown and the schema.org offer of the event page.
 */
export function publicPriceRanges(map: Pick<PublicSeatMap, 'categories' | 'ticketTypes'>): {
  byCategory: Map<string, PriceRange>;
  overall: PriceRange | null;
} {
  const general = map.ticketTypes.filter((t) => t.requiredSeatFeature === null);
  const offered = general.length ? general : map.ticketTypes;
  const byCategory = new Map<string, PriceRange>();
  for (const c of map.categories) {
    const prices = offered.map((t) => t.prices[c.id]).filter((p): p is number => p !== undefined);
    byCategory.set(
      c.id,
      prices.length
        ? { min: Math.min(...prices), max: Math.max(...prices) }
        : { min: c.basePrice, max: c.basePrice },
    );
  }
  const all = [...byCategory.values()];
  return {
    byCategory,
    overall: all.length
      ? { min: Math.min(...all.map((r) => r.min)), max: Math.max(...all.map((r) => r.max)) }
      : null,
  };
}
