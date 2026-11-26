import { adminUsers, events } from '@tix/db';
import {
  SEAT_FLAG,
  checkoutInputSchema,
  type CheckoutInput,
  type PublicSeatMap,
} from '@tix/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  addSeats,
  allowedTypesFor,
  bestAvailable,
  discardCart,
  getAvailability,
  setGeneralAdmission,
  setTariff,
} from './cart';
import { DomainError, type CoreContext } from './context';
import {
  computeSaleState,
  effectiveCheckoutConfig,
  effectiveQueueConfig,
  type EffectiveCheckoutConfig,
  type EventRow,
} from './events';
import {
  createBoxOfficeOrder,
  type BoxOfficeLine,
  type BoxOfficePaymentMethod,
} from './orders/box-office';
import { placeOrder } from './orders/checkout';
import { recordPayment } from './orders/fulfillment';
import { getCheckoutOptions, paymentAvailabilityForEvents } from './orders/pricing';
import { enterShop } from './queue';
import { getPublicSeatMap, getSeatMapForChannel } from './seatmaps/public';
import { ensureOrderTickets } from './tickets/issue';
import { transferTicket } from './tickets/self-service';

/**
 * Demo data for DEMO / TEST installations (`tix demo-orders`): realistic REGULAR orders created
 * through the same core paths the shop and the box office use – cart (best available / seat
 * selection / standing spots, tariffs), checkout (Vorkasse), payment recording, box office sales
 * and ticket hand-over. Nothing here is a test purchase (`is_test`); paid orders get real (GoBD)
 * invoices that can never be deleted – the only clean-up is restoring a backup.
 *
 * Waiting room: the core cart / checkout functions do not check the QueuePassToken (only the web
 * layer does, `requireShopAccess`). The generator therefore enters the shop (`enterShop`) only in
 * queue mode OFF and never joins a real queue or takes active-shopper slots in the other modes.
 * Events in mode VIP_CODE_ONLY and events outside the public sale are skipped.
 *
 * E-mails: every order path writes its mails into the outbox in the order transaction and
 * enqueues the BullMQ job via `ctx.jobs` after the commit – the running worker sends them (its
 * sweeper re-queues anything whose job could not be added).
 */

export const DEMO_MAX_REAL_ADDRESSES = 3;
/** Share of the free capacity of an event the generator may use at most. */
export const DEMO_CAPACITY_SHARE = 0.4;
const DEMO_NOTE = 'Demo data (demo-orders CLI)';

export type DemoScenario = 'UNPAID' | 'PAID' | 'MULTI_EVENT' | 'BOX_OFFICE';

export interface DemoOrdersOptions {
  /** Number of orders with fake buyers (real-address orders come on top). */
  count: number;
  /** Up to three real e-mail addresses (A, B, C – see `realScript`). */
  real?: string[];
  /** Restrict to these event slugs (default: all published events on sale). */
  eventSlugs?: string[];
  seed: number;
  /** Called once with the plan BEFORE anything is created; return false to abort. */
  onPlan?: (plan: DemoPlan) => boolean | Promise<boolean>;
  /** Progress output. */
  log?: (line: string) => void;
}

export interface DemoPlanEvent {
  id: string;
  slug: string;
  title: string;
  queueMode: string;
  /** Free seats + standing spots right now. */
  free: number;
  /** Tickets the generator may take at most (share of `free`). */
  budget: number;
  /**
   * Vorkasse can be ordered for this event right now. False e.g. within the "disable N days
   * before the event" window: the event then only gets box office sales.
   */
  vorkasse: boolean;
  vorkasseReason: string | null;
}

export interface DemoPlan {
  appUrl: string | null;
  seed: number;
  events: DemoPlanEvent[];
  /** Events that were considered but are not used, with the reason. */
  skippedEvents: { slug: string; reason: string }[];
  /** Planned fake orders per scenario. */
  mix: Record<DemoScenario, number>;
  /** Planned orders per real address (A, B, C). */
  real: { label: 'A' | 'B' | 'C'; email: string; orders: string[] }[];
  boxOfficeUser: { id: string; email: string } | null;
  notes: string[];
}

export interface DemoOrderRow {
  orderNumber: string;
  orderId: string;
  scenario: DemoScenario;
  buyer: string;
  status: string;
  method: string;
  events: string[];
  tickets: number;
  totalGross: number;
  currency: string;
  /** Real-address label (A, B, C) when the buyer is one of the real addresses. */
  real: 'A' | 'B' | 'C' | null;
  /** Set when a step after creating the order failed (e.g. "payment failed: <code>"). */
  note?: string;
}

export interface DemoOrdersResult {
  plan: DemoPlan;
  aborted: boolean;
  orders: DemoOrderRow[];
  failures: { scenario: DemoScenario; buyer: string; reason: string }[];
  transfer:
    | { status: 'DONE'; fromOrder: string; to: string; newTicketId: string }
    | { status: 'SKIPPED'; reason: string }
    | null;
  notes: string[];
}

// ─── Deterministic randomness ───────────────────────────────────────────────

export function demoRandom(seed: number): () => number {
  // mulberry32: small, fast and reproducible for a given seed
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
function shuffle<T>(rng: Rng, list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}
/** 1–4 tickets, 2 most common. */
const ticketCount = (rng: Rng) => pick(rng, [1, 2, 2, 2, 3, 3, 4]);

// ─── Fake buyers ────────────────────────────────────────────────────────────

const GERMAN_FIRST = [
  'Lena',
  'Jonas',
  'Mia',
  'Lukas',
  'Hannah',
  'Felix',
  'Sophie',
  'Paul',
  'Emma',
  'Maximilian',
  'Clara',
  'Tim',
  'Johanna',
  'Moritz',
  'Greta',
  'Jürgen',
  'Ursula',
  'Klaus',
  'Sabine',
  'Özlem',
];
const GERMAN_LAST = [
  'Schmidt',
  'Müller',
  'Schneider',
  'Fischer',
  'Weber',
  'Meyer',
  'Wagner',
  'Becker',
  'Hoffmann',
  'Schäfer',
  'Koch',
  'Richter',
  'Klein',
  'Wolf',
  'Neumann',
  'Schwarz',
  'Krüger',
  'Yılmaz',
];
const ENGLISH_FIRST = [
  'Oliver',
  'Amelia',
  'George',
  'Isla',
  'Harry',
  'Ava',
  'Jack',
  'Grace',
  'Noah',
  'Chloe',
];
const ENGLISH_LAST = [
  'Smith',
  'Jones',
  'Taylor',
  'Brown',
  'Williams',
  'Wilson',
  'Evans',
  'Thomas',
  'Roberts',
  'Walker',
];
const STREETS_DE = [
  'Hauptstraße',
  'Bahnhofstraße',
  'Gartenweg',
  'Schulstraße',
  'Lindenallee',
  'Rheinufer',
];
const STREETS_EN = ['High Street', 'Station Road', 'Church Lane', 'Park Avenue', 'Mill Road'];
/** Fictitious postal codes, real city names. */
const CITIES: { city: string; postalCode: string; country: string; english: boolean }[] = [
  { city: 'Berlin', postalCode: '10115', country: 'DE', english: false },
  { city: 'Hamburg', postalCode: '20095', country: 'DE', english: false },
  { city: 'München', postalCode: '80331', country: 'DE', english: false },
  { city: 'Köln', postalCode: '50667', country: 'DE', english: false },
  { city: 'Leipzig', postalCode: '04109', country: 'DE', english: false },
  { city: 'Dresden', postalCode: '01067', country: 'DE', english: false },
  { city: 'Stuttgart', postalCode: '70173', country: 'DE', english: false },
  { city: 'Hannover', postalCode: '30159', country: 'DE', english: false },
  { city: 'Nürnberg', postalCode: '90402', country: 'DE', english: false },
  { city: 'Bremen', postalCode: '28195', country: 'DE', english: false },
  { city: 'Düsseldorf', postalCode: '40213', country: 'DE', english: false },
  { city: 'Dortmund', postalCode: '44135', country: 'DE', english: false },
  { city: 'Münster', postalCode: '48143', country: 'DE', english: false },
  { city: 'Kiel', postalCode: '24103', country: 'DE', english: false },
  { city: 'Rostock', postalCode: '18055', country: 'DE', english: false },
  { city: 'Freiburg im Breisgau', postalCode: '79098', country: 'DE', english: false },
  { city: 'Wien', postalCode: '1010', country: 'AT', english: false },
  { city: 'Graz', postalCode: '8010', country: 'AT', english: false },
  { city: 'Salzburg', postalCode: '5020', country: 'AT', english: false },
  { city: 'Zürich', postalCode: '8001', country: 'CH', english: false },
  { city: 'Basel', postalCode: '4051', country: 'CH', english: false },
  { city: 'Bern', postalCode: '3011', country: 'CH', english: false },
  { city: 'London', postalCode: 'SW1A 1AA', country: 'GB', english: true },
  { city: 'Manchester', postalCode: 'M1 1AE', country: 'GB', english: true },
  { city: 'Dublin', postalCode: 'D02 X285', country: 'IE', english: true },
];

export interface DemoBuyer {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: { street: string; postalCode: string; city: string; country: string };
  locale: CheckoutInput['locale'];
}

const ascii = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[^a-z]/g, '');

/** Fake buyer on the reserved domain example.org (RFC 2606) – mails there are never delivered. */
export function fakeBuyer(rng: Rng, serial: number, email?: string): DemoBuyer {
  const place = pick(rng, CITIES);
  const english = place.english || rng() < 0.15;
  const firstName = pick(rng, english ? ENGLISH_FIRST : GERMAN_FIRST);
  const lastName = pick(rng, english ? ENGLISH_LAST : GERMAN_LAST);
  const street = `${pick(rng, english && place.english ? STREETS_EN : STREETS_DE)} ${1 + Math.floor(rng() * 120)}`;
  // Only number ranges reserved for fiction: Ofcom drama range +44 7700 900000-900999 and the
  // Bundesnetzagentur film/TV range +49 30 23125 000-999.
  const suffix = String(Math.floor(rng() * 1000)).padStart(3, '0');
  return {
    email:
      email ??
      `${ascii(firstName)}.${ascii(lastName)}.${String(serial).padStart(2, '0')}@example.org`,
    firstName,
    lastName,
    phone: place.english ? `+44 7700 900${suffix}` : `+49 30 23125 ${suffix}`,
    address: { street, postalCode: place.postalCode, city: place.city, country: place.country },
    locale: english ? 'en' : 'de',
  };
}

// ─── Events ─────────────────────────────────────────────────────────────────

interface DemoEvent {
  row: EventRow;
  map: PublicSeatMap;
  config: EffectiveCheckoutConfig;
  queueMode: string;
  free: number;
  budget: number;
  used: number;
  vorkasse: boolean;
  vorkasseReason: string | null;
}

const freeSeatIds = (map: PublicSeatMap, unavailable: Set<string>) =>
  map.seats.filter(
    (s) =>
      s.c &&
      (s.f & SEAT_FLAG.BLOCKED) === 0 &&
      !unavailable.has(s.i) &&
      allowedTypesFor(map, s.c, s.f).length > 0,
  );

/**
 * Free seats a regular buyer can take: wheelchair spaces and companion seats are left alone (a
 * "wheelchair" category with a handful of such spaces can never serve 2–4 regular tickets).
 */
const regularFreeSeats = (map: PublicSeatMap, unavailable: Set<string>) =>
  freeSeatIds(map, unavailable).filter(
    (s) => (s.f & (SEAT_FLAG.WHEELCHAIR | SEAT_FLAG.COMPANION)) === 0,
  );

async function loadDemoEvents(
  ctx: CoreContext,
  slugs: string[] | undefined,
): Promise<{ usable: DemoEvent[]; skipped: { slug: string; reason: string }[] }> {
  const rows = await ctx.db
    .select()
    .from(events)
    .where(slugs?.length ? inArray(events.slug, slugs) : eq(events.status, 'PUBLISHED'))
    .orderBy(asc(events.startsAt));
  const skipped: { slug: string; reason: string }[] = [];
  for (const slug of slugs ?? []) {
    if (!rows.some((r) => r.slug === slug)) skipped.push({ slug, reason: 'not found' });
  }
  const usable: DemoEvent[] = [];
  for (const row of rows) {
    if (row.status !== 'PUBLISHED') {
      skipped.push({ slug: row.slug, reason: `status ${row.status}` });
      continue;
    }
    const state = computeSaleState(row);
    if (state !== 'ON_SALE') {
      skipped.push({ slug: row.slug, reason: `sale state ${state}` });
      continue;
    }
    const queue = await effectiveQueueConfig(ctx, row.id);
    if (queue.mode === 'VIP_CODE_ONLY') {
      skipped.push({ slug: row.slug, reason: 'access-code-only waiting room' });
      continue;
    }
    if (!row.seatMapId) {
      skipped.push({ slug: row.slug, reason: 'no seating plan' });
      continue;
    }
    try {
      const map = await getPublicSeatMap(ctx, row, { fresh: true });
      const config = await effectiveCheckoutConfig(ctx, row);
      const availability = await getAvailability(ctx, null, row);
      const unavailable = new Set([...availability.taken, ...availability.locked]);
      const seats =
        config.manualSeatSelectionEnabled || config.bestAvailableEnabled
          ? freeSeatIds(map, unavailable).length
          : 0;
      const standing = map.sections
        .filter((s) => s.type === 'STANDING' && s.priceCategoryId)
        .reduce((sum, s) => sum + Math.max(0, availability.ga[s.id] ?? 0), 0);
      const free = seats + standing;
      const budget = Math.floor(free * DEMO_CAPACITY_SHARE);
      if (budget < 1) {
        skipped.push({ slug: row.slug, reason: 'no free capacity (or no bookable seats)' });
        continue;
      }
      const bankReason = (await paymentAvailabilityForEvents(ctx, [row])).BANK_TRANSFER ?? null;
      usable.push({
        row,
        map,
        config,
        queueMode: queue.mode,
        free,
        budget,
        used: 0,
        vorkasse: bankReason === null,
        vorkasseReason: bankReason,
      });
    } catch (err) {
      skipped.push({ slug: row.slug, reason: `seating plan not usable: ${errorText(err)}` });
    }
  }
  return { usable, skipped };
}

// ─── Seat picking (through the shop's cart functions) ───────────────────────

interface Picked {
  seatIds: string[];
  ga: { sectionId: string; quantity: number } | null;
}

/** First run of `qty` free seats in a row that leaves no single isolated seat next to it. */
function manualRun(
  rng: Rng,
  map: PublicSeatMap,
  categoryId: string,
  qty: number,
  unavailable: Set<string>,
): string[] | null {
  const byRow = new Map<string, PublicSeatMap['seats']>();
  for (const s of map.seats) {
    if (s.c !== categoryId || !s.r) continue;
    const list = byRow.get(s.r) ?? [];
    list.push(s);
    byRow.set(s.r, list);
  }
  const candidates: string[][] = [];
  for (const seats of byRow.values()) {
    seats.sort((a, b) => (a.p ?? 0) - (b.p ?? 0));
    const free = seats.map(
      (s) =>
        !unavailable.has(s.i) &&
        (s.f & (SEAT_FLAG.BLOCKED | SEAT_FLAG.WHEELCHAIR | SEAT_FLAG.COMPANION)) === 0 &&
        allowedTypesFor(map, categoryId, s.f).length > 0,
    );
    for (let i = 0; i + qty <= seats.length; i += 1) {
      if (i > 0 && free[i - 1]) continue;
      if (!free.slice(i, i + qty).every(Boolean)) continue;
      const after = i + qty;
      if (free[after] && !free[after + 1]) continue; // would orphan the next seat
      candidates.push(seats.slice(i, i + qty).map((s) => s.i));
      break;
    }
  }
  return candidates.length ? pick(rng, candidates) : null;
}

async function pickItems(
  ctx: CoreContext,
  rng: Rng,
  sessionId: string,
  ev: DemoEvent,
  qty: number,
): Promise<Picked> {
  const { map, config, row } = ev;
  const availability = await getAvailability(ctx, sessionId, row);
  const unavailable = new Set([
    ...availability.taken,
    ...availability.locked,
    ...availability.mine,
  ]);
  const standing = map.sections.filter(
    (s) => s.type === 'STANDING' && s.priceCategoryId && (availability.ga[s.id] ?? 0) >= qty,
  );
  // Only categories with enough regular seats for this order (a "wheelchair" category with a few
  // wheelchair/companion spaces never qualifies).
  const regular = regularFreeSeats(map, unavailable);
  const seatCategories = map.categories.filter(
    (c) =>
      regular.filter((s) => s.c === c.id).length >= Math.min(qty, c.maxPerOrder ?? qty) &&
      ((config.bestAvailableEnabled && c.bestAvailable) || config.manualSeatSelectionEnabled),
  );
  const seatsPossible = seatCategories.length > 0;
  if (standing.length > 0 && (!seatsPossible || rng() < 0.2)) {
    const section = pick(rng, standing);
    await setGeneralAdmission(ctx, sessionId, row, section.id, qty);
    return { seatIds: [], ga: { sectionId: section.id, quantity: qty } };
  }
  if (!seatsPossible) throw new DomainError('NOT_ENOUGH_SEATS', 'No bookable seats left', 409);
  // A category whose free seats are too scattered (orphan rule, no contiguous run) is skipped in
  // favour of the next one; only when none works is the order reported as skipped.
  let lastError: unknown = null;
  for (const category of shuffle(rng, [...seatCategories])) {
    const quantity = Math.min(qty, category.maxPerOrder ?? qty);
    try {
      if (
        config.bestAvailableEnabled &&
        category.bestAvailable &&
        (rng() < 0.7 || !config.manualSeatSelectionEnabled)
      ) {
        const result = await bestAvailable(ctx, sessionId, row, category.id, quantity);
        return { seatIds: result.seatIds, ga: null };
      }
      const run = manualRun(rng, map, category.id, quantity, unavailable);
      if (!run) throw new DomainError('NOT_ENOUGH_SEATS', 'No contiguous seats left', 409);
      await addSeats(ctx, sessionId, row, run);
      return { seatIds: run, ga: null };
    } catch (err) {
      if (!(err instanceof DomainError) || !SEAT_RETRY_CODES.has(err.code)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/** Seat picking errors after which the generator tries the next price category. */
const SEAT_RETRY_CODES: ReadonlySet<string> = new Set([
  'NOT_ENOUGH_SEATS',
  'SEAT_UNAVAILABLE',
  'SEAT_LOCKED',
  'NOT_AVAILABLE',
]);

/** Sets a reduced (non-default, not seat-bound) tariff on one item of the cart, if any exists. */
async function maybeReduce(
  ctx: CoreContext,
  rng: Rng,
  sessionId: string,
  ev: DemoEvent,
  picked: Picked,
): Promise<void> {
  if (rng() >= 0.3) return;
  const seatsById = new Map(ev.map.seats.map((s) => [s.i, s]));
  const options: { key: string; categoryId: string; flags: number | null }[] = [
    ...picked.seatIds.map((id) => ({
      key: id,
      categoryId: seatsById.get(id)!.c!,
      flags: seatsById.get(id)!.f,
    })),
  ];
  if (picked.ga) {
    const section = ev.map.sections.find((s) => s.id === picked.ga!.sectionId)!;
    options.push({ key: `ga:${section.id}:0`, categoryId: section.priceCategoryId!, flags: null });
  }
  if (options.length === 0) return;
  const item = pick(rng, options);
  const reduced = allowedTypesFor(ev.map, item.categoryId, item.flags).filter(
    (t) => !t.isDefault && t.requiredSeatFeature === null,
  );
  if (reduced.length === 0) return;
  await setTariff(ctx, sessionId, ev.row, item.key, pick(rng, reduced).id).catch(() => undefined);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const errorText = (err: unknown) =>
  err instanceof DomainError
    ? `${err.code}${err.details ? ` ${JSON.stringify(err.details)}` : ''}`
    : err instanceof Error
      ? err.message
      : String(err);

interface OrderSpec {
  scenario: DemoScenario;
  buyer: DemoBuyer;
  real: 'A' | 'B' | 'C' | null;
  /** Number of events (MULTI_EVENT = 2). */
  eventCount: number;
  /** At least this many tickets (A's order whose ticket is passed on keeps one). */
  minTickets?: number;
  boxPayment?: BoxOfficePaymentMethod;
  /** This order's first ticket is passed on to B. */
  transferSource?: boolean;
}

function planMix(
  count: number,
  multiPossible: boolean,
  boxPossible: boolean,
  onlinePossible = true,
) {
  const mix: Record<DemoScenario, number> = { UNPAID: 0, PAID: 0, MULTI_EVENT: 0, BOX_OFFICE: 0 };
  // No event takes Vorkasse orders right now: only box office sales remain.
  if (!onlinePossible) {
    mix.BOX_OFFICE = boxPossible ? count : 0;
    return mix;
  }
  const shares: [DemoScenario, number][] = [
    ['UNPAID', 0.35],
    ['PAID', 0.35],
    ['MULTI_EVENT', multiPossible ? 0.1 : 0],
    ['BOX_OFFICE', boxPossible ? 0.15 : 0],
  ];
  let assigned = 0;
  for (const [scenario, share] of shares) {
    mix[scenario] = Math.floor(count * share);
    assigned += mix[scenario];
  }
  // The remainder alternates between unpaid and paid Vorkasse orders.
  for (let i = 0; assigned < count; i += 1, assigned += 1)
    mix[i % 2 === 0 ? 'UNPAID' : 'PAID'] += 1;
  return mix;
}

export async function generateDemoOrders(
  ctx: CoreContext,
  options: DemoOrdersOptions,
): Promise<DemoOrdersResult> {
  const log = options.log ?? (() => undefined);
  const rng = demoRandom(options.seed);
  const real = (options.real ?? []).map((e) => e.trim().toLowerCase());
  if (real.length > DEMO_MAX_REAL_ADDRESSES) {
    throw new Error(`At most ${DEMO_MAX_REAL_ADDRESSES} real addresses are supported`);
  }
  if (new Set(real).size !== real.length) throw new Error('The real addresses must differ');

  const { usable, skipped } = await loadDemoEvents(ctx, options.eventSlugs);
  const [boxUser] = await ctx.db
    .select({ id: adminUsers.id, email: adminUsers.email })
    .from(adminUsers)
    .where(and(eq(adminUsers.isActive, true), sql`'SUPER_ADMIN' = ANY(${adminUsers.roles})`))
    .orderBy(asc(adminUsers.createdAt))
    .limit(1);
  const notes: string[] = [];
  if (!boxUser) notes.push('No active SUPER_ADMIN found: box office orders are skipped.');
  const vorkasseEvents = usable.filter((e) => e.vorkasse).length;
  if (usable.length > 0 && vorkasseEvents === 0) {
    notes.push(
      'No event takes Vorkasse orders right now (e.g. too close to the event): only box office sales, no orders for the real addresses.',
    );
  } else if (vorkasseEvents < 2) {
    notes.push('Fewer than two events take Vorkasse orders: no multi-event orders.');
  }

  const multiPossible = vorkasseEvents >= 2;
  const mix = planMix(options.count, multiPossible, Boolean(boxUser), vorkasseEvents > 0);

  // Real addresses: A = 3 orders + passes a ticket on to B, B = 1 paid order, C = paid + unpaid.
  const labels = ['A', 'B', 'C'] as const;
  const realSpecs: OrderSpec[] = [];
  const realPlan: DemoPlan['real'] = [];
  let serial = 1;
  // Every real-address order is a Vorkasse order.
  (vorkasseEvents > 0 ? real : []).forEach((email, i) => {
    const label = labels[i]!;
    const buyer = fakeBuyer(rng, 0, email);
    const steps: string[] = [];
    const add = (spec: Omit<OrderSpec, 'buyer' | 'real'>, text: string) => {
      realSpecs.push({ ...spec, buyer, real: label });
      steps.push(text);
    };
    if (label === 'A') {
      add({ scenario: 'UNPAID', eventCount: 1 }, 'Vorkasse unpaid');
      add(
        { scenario: 'PAID', eventCount: 1, minTickets: 2, transferSource: real.length > 1 },
        real.length > 1 ? 'Vorkasse paid (one ticket is passed on to B)' : 'Vorkasse paid',
      );
      if (multiPossible) add({ scenario: 'MULTI_EVENT', eventCount: 2 }, 'multi-event, paid');
    } else if (label === 'B') {
      add({ scenario: 'PAID', eventCount: 1 }, 'Vorkasse paid');
      if (real[0])
        steps.push('receives one ticket from A (if ticket self-service allows transfers)');
    } else {
      add({ scenario: 'PAID', eventCount: 1 }, 'Vorkasse paid');
      add({ scenario: 'UNPAID', eventCount: 1 }, 'Vorkasse unpaid');
    }
    realPlan.push({ label, email, orders: steps });
  });

  const plan: DemoPlan = {
    appUrl: ctx.appUrl ?? null,
    seed: options.seed,
    events: usable.map((e) => ({
      id: e.row.id,
      slug: e.row.slug,
      title: e.row.title,
      queueMode: e.queueMode,
      free: e.free,
      budget: e.budget,
      vorkasse: e.vorkasse,
      vorkasseReason: e.vorkasseReason,
    })),
    skippedEvents: skipped,
    mix,
    real: realPlan,
    boxOfficeUser: boxUser ?? null,
    notes,
  };
  const result: DemoOrdersResult = {
    plan,
    aborted: false,
    orders: [],
    failures: [],
    transfer: null,
    notes: [...notes],
  };
  if (usable.length === 0) {
    result.aborted = true;
    result.notes.push('No published event is on sale – nothing to do.');
    return result;
  }
  if (options.onPlan && !(await options.onPlan(plan))) {
    result.aborted = true;
    return result;
  }

  const fakeSpecs: OrderSpec[] = [];
  const boxPayments: BoxOfficePaymentMethod[] = ['CASH', 'CARD', 'COMPLIMENTARY'];
  for (const scenario of ['UNPAID', 'PAID', 'MULTI_EVENT', 'BOX_OFFICE'] as const) {
    for (let i = 0; i < mix[scenario]; i += 1) {
      fakeSpecs.push({
        scenario,
        buyer: fakeBuyer(rng, serial++),
        real: null,
        eventCount: scenario === 'MULTI_EVENT' ? 2 : 1,
        ...(scenario === 'BOX_OFFICE' ? { boxPayment: boxPayments[i % boxPayments.length] } : {}),
      });
    }
  }
  // Real-address orders first (they must not lose the capacity race), the rest shuffled.
  const specs = [...realSpecs, ...shuffle(rng, fakeSpecs)];

  let transferSource: { orderId: string; orderNumber: string } | null = null;
  for (const spec of specs) {
    const who = spec.real ? `${spec.buyer.email} (${spec.real})` : spec.buyer.email;
    try {
      const row =
        spec.scenario === 'BOX_OFFICE'
          ? await boxOfficeOrder(ctx, rng, usable, boxUser!.id, spec)
          : await onlineOrder(ctx, rng, usable, spec);
      result.orders.push(row);
      log(`created ${row.orderNumber} (${row.scenario})${row.note ? ` – ${row.note}` : ''}`);
      if (spec.transferSource && row.status === 'PAID') {
        transferSource = { orderId: row.orderId, orderNumber: row.orderNumber };
      }
    } catch (err) {
      const reason = errorText(err);
      result.failures.push({ scenario: spec.scenario, buyer: who, reason });
      log(`skipped ${spec.scenario} for ${who}: ${reason}`);
      if (err instanceof DemoCapacityError) break;
    }
  }

  // A passes one ticket of the paid order on to B (customer self-service rules apply).
  if (realSpecs.some((s) => s.real === 'B')) {
    if (!transferSource) {
      result.transfer = { status: 'SKIPPED', reason: "A's paid order could not be created" };
    } else {
      try {
        const tickets = await ensureOrderTickets(ctx, transferSource.orderId);
        const ticket = tickets.find((t) => t.status === 'VALID');
        if (!ticket) throw new DomainError('NO_TICKET', 'The order has no valid ticket', 409);
        const b = realSpecs.find((s) => s.real === 'B')!.buyer;
        const done = await transferTicket(ctx, {
          orderId: transferSource.orderId,
          ticketId: ticket.id,
          recipientName: `${b.firstName} ${b.lastName}`,
          recipientEmail: b.email,
          actor: { type: 'CUSTOMER' },
        });
        result.transfer = {
          status: 'DONE',
          fromOrder: transferSource.orderNumber,
          to: b.email,
          newTicketId: done.newTicketId,
        };
      } catch (err) {
        result.transfer = { status: 'SKIPPED', reason: errorText(err) };
      }
    }
    if (result.transfer.status === 'SKIPPED') {
      result.notes.push(
        `Ticket hand-over A -> B skipped: ${result.transfer.reason} (customer self-service must allow transfers: Admin -> Settings -> Ticket self-service, or the event's "Sales" tab).`,
      );
    }
  }
  return result;
}

class DemoCapacityError extends DomainError {
  constructor() {
    super('DEMO_CAPACITY', 'The capacity share of all events is used up', 409);
  }
}

/** Events with room for `qty` more tickets, in random order. */
function eventsWithRoom(rng: Rng, list: DemoEvent[], qty: number): DemoEvent[] {
  return shuffle(
    rng,
    list.filter((e) => e.budget - e.used >= qty),
  );
}

function clampQty(ev: DemoEvent, qty: number): number {
  return Math.max(1, Math.min(qty, ev.config.maxTicketsPerOrder ?? qty, ev.budget - ev.used));
}

async function onlineOrder(
  ctx: CoreContext,
  rng: Rng,
  usable: DemoEvent[],
  spec: OrderSpec,
): Promise<DemoOrderRow> {
  const wanted = Math.max(spec.minTickets ?? 1, ticketCount(rng));
  const perEvent = spec.eventCount > 1 ? Math.min(2, wanted) : wanted;
  const chosen = eventsWithRoom(
    rng,
    usable.filter((e) => e.vorkasse),
    spec.minTickets ?? 1,
  ).slice(0, spec.eventCount);
  if (chosen.length === 0) {
    // Only the events without Vorkasse have room left: box office sales may still go on.
    if (usable.some((e) => e.budget - e.used >= 1)) {
      throw new DomainError('DEMO_NO_EVENTS', 'No Vorkasse event has capacity left', 409);
    }
    throw new DemoCapacityError();
  }
  if (chosen.length < spec.eventCount) {
    throw new DomainError('DEMO_NO_EVENTS', 'Not enough events with free capacity', 409);
  }
  const sessionId = `demo-${randomUUID()}`;
  let placed = false;
  try {
    const perEventTickets = new Map<DemoEvent, number>();
    for (const ev of chosen) {
      if (ev.queueMode === 'OFF') await enterShop(ctx, ev.row, sessionId);
      const qty = clampQty(ev, perEvent);
      const picked = await pickItems(ctx, rng, sessionId, ev, qty);
      await maybeReduce(ctx, rng, sessionId, ev, picked);
      perEventTickets.set(ev, picked.seatIds.length + (picked.ga?.quantity ?? 0));
    }
    const tickets = [...perEventTickets.values()].reduce((a, b) => a + b, 0);
    if (spec.minTickets && tickets < spec.minTickets) {
      throw new DomainError('DEMO_TOO_FEW', 'Not enough seats for this order', 409);
    }
    const { quotes, methods } = await getCheckoutOptions(ctx, sessionId, spec.buyer.locale);
    const bank = methods.find((m) => m.method === 'BANK_TRANSFER');
    if (!bank?.available) {
      throw new DomainError('BANK_TRANSFER_UNAVAILABLE', 'Vorkasse is not available', 409, {
        reason: bank?.reason,
      });
    }
    const order = await placeOrder(ctx, {
      sessionId,
      input: checkoutInputSchema.parse({
        method: 'BANK_TRANSFER',
        email: spec.buyer.email,
        firstName: spec.buyer.firstName,
        lastName: spec.buyer.lastName,
        phone: spec.buyer.phone,
        address: spec.buyer.address,
        acceptTerms: true,
        expectedTotalGross: quotes.BANK_TRANSFER.totalGross,
        locale: spec.buyer.locale,
      }),
    });
    placed = true;
    for (const [ev, n] of perEventTickets) ev.used += n;
    let status: string = order.status;
    let note: string | undefined;
    const pay = spec.scenario === 'PAID' || spec.scenario === 'MULTI_EVENT';
    if (pay && order.status !== 'PAID' && order.totalGross > 0) {
      try {
        const paid = await recordPayment(ctx, {
          orderId: order.orderId,
          amount: order.totalGross,
          currency: order.currency,
          method: 'BANK_TRANSFER',
          providerResponse: { note: DEMO_NOTE },
          actor: { type: 'SYSTEM' },
        });
        status = paid.status === 'PAID' ? 'PAID' : status;
      } catch (err) {
        // The order exists (unpaid): report it as created, never as skipped.
        note = `payment failed: ${err instanceof DomainError ? err.code : errorText(err)}`;
      }
    }
    return {
      orderNumber: order.orderNumber,
      orderId: order.orderId,
      scenario: spec.scenario,
      buyer: spec.buyer.email,
      status,
      method: order.method,
      events: chosen.map((e) => e.row.title),
      tickets,
      totalGross: order.totalGross,
      currency: order.currency,
      real: spec.real,
      ...(note ? { note } : {}),
    };
  } finally {
    // A failed order must never leave seats locked on a live demo.
    if (!placed) await discardCart(ctx, sessionId).catch(() => undefined);
  }
}

async function boxOfficeOrder(
  ctx: CoreContext,
  rng: Rng,
  usable: DemoEvent[],
  userId: string,
  spec: OrderSpec,
): Promise<DemoOrderRow> {
  const [ev] = eventsWithRoom(rng, usable, 1);
  if (!ev) throw new DemoCapacityError();
  const qty = clampQty(ev, ticketCount(rng));
  // The seats are found with the shop's own picking (best available / orphan-free runs) under a
  // throw-away session, released and sold at the counter right away.
  const sessionId = `demo-bo-${randomUUID()}`;
  let picked: Picked;
  try {
    picked = await pickItems(ctx, rng, sessionId, ev, qty);
  } finally {
    await discardCart(ctx, sessionId).catch(() => undefined);
  }
  const channelMap = await getSeatMapForChannel(ctx, ev.row, 'BOX_OFFICE');
  const tariffFor = (categoryId: string, flags: number | null) => {
    const allowed = allowedTypesFor(channelMap, categoryId, flags);
    const featured = allowed.find((t) => t.requiredSeatFeature !== null);
    const type = featured ?? allowed.find((t) => t.isDefault) ?? allowed[0];
    if (!type) throw new DomainError('TARIFF_NOT_ALLOWED', 'No box office tariff', 422);
    return type.id;
  };
  const seatsById = new Map(channelMap.seats.map((s) => [s.i, s]));
  const lines: BoxOfficeLine[] = picked.seatIds.map((seatId) => {
    const seat = seatsById.get(seatId)!;
    return { eventId: ev.row.id, seatId, ticketTypeId: tariffFor(seat.c!, seat.f) };
  });
  if (picked.ga) {
    const section = channelMap.sections.find((s) => s.id === picked.ga!.sectionId)!;
    lines.push({
      eventId: ev.row.id,
      sectionId: section.id,
      quantity: picked.ga.quantity,
      ticketTypeId: tariffFor(section.priceCategoryId!, null),
    });
  }
  const payment = spec.boxPayment ?? 'CASH';
  const order = await createBoxOfficeOrder(ctx, {
    userId,
    channel: 'BOX_OFFICE',
    lines,
    payment,
    // No e-mail: box office buyers get no mail, the order still counts in the cash-up.
    buyer: {
      firstName: spec.buyer.firstName,
      lastName: spec.buyer.lastName,
      address: spec.buyer.address,
    },
    sendEmail: false,
    note: DEMO_NOTE,
    locale: spec.buyer.locale,
  });
  ev.used += order.ticketCount;
  return {
    orderNumber: order.orderNumber,
    orderId: order.orderId,
    scenario: 'BOX_OFFICE',
    buyer: `${spec.buyer.firstName} ${spec.buyer.lastName} (box office, no e-mail)`,
    status: order.status,
    method: payment,
    events: [ev.row.title],
    tickets: order.ticketCount,
    totalGross: order.totalGross,
    currency: order.currency,
    real: null,
  };
}
