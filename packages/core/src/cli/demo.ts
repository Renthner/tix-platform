/**
 * Creates a self-contained demo: a venue with a master seating plan (curved stalls, balcony,
 * standing area, stage), and a published event on sale with categories and tariffs.
 *
 *   pnpm db:demo
 *
 * Idempotent per slug: running it twice does not duplicate data.
 */
import { randomUUID } from 'node:crypto';
import {
  createDb,
  events,
  loadRootEnv,
  priceCategories,
  priceCategoryTicketTypes,
  seatMaps,
  svgSymbols,
  taxRates,
  ticketTypes,
  venues,
} from '@tix/db';
import {
  layoutRowSeats,
  seatNumbers,
  type DocRow,
  type DocSeat,
  type DocSection,
  type SeatMapDocument,
} from '@tix/shared';
import { eq } from 'drizzle-orm';
import { cloneSeatMap } from '../seatmaps/clone';
import { flushShopCacheBestEffort } from './flush-shop-cache';
import { loadSeatMapDocument, saveSeatMapDocument } from '../seatmaps/document';

loadRootEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const VENUE_SLUG = 'demo-theatre';
const EVENT_SLUG = 'demo-concert';

/** Ids of seeded built-in symbols by builtin key (may be empty if the seed was not run). */
type SymbolIds = Map<string, string>;

function buildTemplate(version: number, symbols: SymbolIds): SeatMapDocument {
  const sections: DocSection[] = [];
  const rows: DocRow[] = [];
  const seats: DocSeat[] = [];
  const stalls = randomUUID();
  const balcony = randomUUID();
  const standing = randomUUID();
  const entrance = randomUUID();
  const base = {
    label: null,
    color: null,
    entranceId: entrance,
    priceCategoryId: null,
    bestAvailablePriority: 100,
    isBestAvailableEnabled: true,
    isActive: true,
    showNameOnMap: true,
    showLabelOnTicket: true,
    translations: {},
  };
  sections.push(
    {
      ...base,
      id: stalls,
      type: 'SEATED',
      name: 'Stalls',
      ticketLabel: 'Stalls',
      sortOrder: 1,
      capacity: null,
      bestAvailablePriority: 1,
      geometry: { type: 'rect', x: 180, y: 260, width: 1040, height: 520, rotation: 0 },
    },
    {
      ...base,
      id: balcony,
      type: 'SEATED',
      name: 'Balcony',
      ticketLabel: 'Balcony',
      sortOrder: 2,
      capacity: null,
      bestAvailablePriority: 2,
      geometry: { type: 'rect', x: 260, y: 820, width: 880, height: 230, rotation: 0 },
    },
    {
      ...base,
      id: standing,
      type: 'STANDING',
      name: 'Standing',
      ticketLabel: 'Standing area',
      sortOrder: 3,
      capacity: 120,
      geometry: {
        type: 'polygon',
        points: [
          { x: 1260, y: 260 },
          { x: 1480, y: 260 },
          { x: 1480, y: 780 },
          { x: 1260, y: 780 },
        ],
      },
    },
  );

  const addRow = (
    sectionId: string,
    label: string,
    sortOrder: number,
    y: number,
    count: number,
    curve: number,
    wheelchairEnds = false,
  ) => {
    const id = randomUUID();
    const half = count * 13;
    const geometry: DocRow['geometry'] = {
      curve: {
        type: 'arc',
        start: { x: 700 - half, y },
        end: { x: 700 + half, y },
        control: { x: 700, y: y + curve },
      },
      seatSpacing: 26,
      numbering: 'ASCENDING',
      labelPlacement: 'BOTH',
    };
    rows.push({ id, sectionId, label, sortOrder, geometry });
    const placed = layoutRowSeats(geometry.curve, count);
    const labels = seatNumbers(count, 'ASCENDING');
    placed.forEach((p, i) => {
      const edge = wheelchairEnds && (i === 0 || i === count - 1);
      const companion = wheelchairEnds && (i === 1 || i === count - 2);
      seats.push({
        id: randomUUID(),
        sectionId,
        rowId: id,
        tableElementId: null,
        label: labels[i]!,
        position: i + 1,
        x: p.x,
        y: p.y,
        rotation: p.rotation, // perpendicular to the row → seats face the stage
        priceCategoryId: null,
        bestAvailableRank: null,
        isWheelchairSpace: edge,
        isCompanionSeat: companion,
        companionOfSeatId: null,
        hasRestrictedView: false,
        blockReason: null,
        blockNote: null,
        attributes: {},
        symbolId: null,
      });
    });
  };
  for (let r = 0; r < 12; r += 1)
    addRow(
      stalls,
      String.fromCharCode(65 + r),
      r + 1,
      300 + r * 38,
      18 + Math.min(r, 6),
      40,
      r === 11,
    );
  for (let r = 0; r < 5; r += 1) addRow(balcony, `R${r + 1}`, 20 + r, 860 + r * 38, 26, 30);

  return {
    version,
    name: 'Main hall',
    canvasWidth: 1600,
    canvasHeight: 1100,
    backgroundAssetId: null,
    categories: [],
    settings: {
      gridSize: 10,
      snapToGrid: true,
      seatRadius: 10,
      showSeatNumbers: true,
      backgroundOpacity: 0.35,
      defaultSeatSymbolId: symbols.get('seat-theatre') ?? null,
    },
    entrances: [
      {
        id: entrance,
        name: 'Main entrance',
        code: 'A',
        x: 700,
        y: 1080,
        sortOrder: 0,
        translations: {},
      },
    ],
    sections,
    rows,
    elements: [
      {
        id: randomUUID(),
        type: 'STAGE',
        sectionId: null,
        label: 'STAGE',
        geometry: {
          type: 'rect',
          x: 380,
          y: 60,
          width: 640,
          height: 140,
          rotation: 0,
          cornerRadius: 12,
        },
        style: {},
        assetId: null,
        translations: {},
        zIndex: 0,
      },
      {
        id: randomUUID(),
        type: 'EXIT',
        sectionId: null,
        label: 'Exit',
        geometry: { type: 'point', x: 120, y: 760, rotation: 0 },
        style: symbols.has('icon-exit')
          ? { symbolId: symbols.get('icon-exit')!, symbolSize: 26 }
          : {},
        assetId: null,
        translations: {},
        zIndex: 1,
      },
      ...(['icon-bar', 'icon-wc'] as const).map((key, i) => ({
        id: randomUUID(),
        type: 'FACILITY' as const,
        sectionId: null,
        label: key === 'icon-bar' ? 'Bar' : 'WC',
        geometry: { type: 'point' as const, x: 1360 + i * 90, y: 960, rotation: 0 },
        style: symbols.has(key)
          ? { symbolId: symbols.get(key)!, symbolSize: 30 }
          : { icon: key === 'icon-bar' ? '🍸' : 'WC' },
        assetId: null,
        translations: {},
        zIndex: 2,
      })),
    ],
    seats,
  };
}

async function main(): Promise<void> {
  const handle = createDb({ connectionString: url!, poolMax: 2, applicationName: 'tix-demo' });
  const db = handle.db;
  try {
    const [existing] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, EVENT_SLUG));
    if (existing) {
      console.log('[demo] demo event already exists – nothing to do');
      return;
    }
    const [tax] = await db.select().from(taxRates).where(eq(taxRates.isDefault, true));
    if (!tax) throw new Error('No default tax rate – run `pnpm db:seed` first');

    const [venue] = await db
      .insert(venues)
      .values({
        name: 'Demo Theatre',
        slug: VENUE_SLUG,
        city: 'Sample City',
        country: 'DE',
        timeZone: 'Europe/Berlin',
        latitude: 50,
        longitude: 8.3,
      })
      .onConflictDoNothing()
      .returning();
    const venueId =
      venue?.id ??
      (await db.select({ id: venues.id }).from(venues).where(eq(venues.slug, VENUE_SLUG)))[0]!.id;

    const [template] = await db
      .insert(seatMaps)
      .values({
        venueId,
        kind: 'TEMPLATE',
        name: 'Main hall',
        canvasWidth: 1600,
        canvasHeight: 1100,
      })
      .returning();
    const saved = await saveSeatMapDocument(
      db,
      template!.id,
      buildTemplate(
        template!.version,
        new Map(
          (await db.select({ id: svgSymbols.id, key: svgSymbols.builtinKey }).from(svgSymbols))
            .filter((r): r is { id: string; key: string } => r.key !== null)
            .map((r) => [r.key, r.id]),
        ),
      ),
      null,
    );
    if (!saved.ok) throw new Error(`Template save failed: ${saved.error.message}`);

    const eventMapId = await db.transaction((tx) =>
      cloneSeatMap(tx, template!.id, { kind: 'EVENT', name: 'Demo concert' }),
    );
    const startsAt = new Date(Date.now() + 21 * 86_400_000);
    startsAt.setUTCHours(18, 0, 0, 0);
    const [event] = await db
      .insert(events)
      .values({
        venueId,
        seatMapId: eventMapId,
        slug: EVENT_SLUG,
        title: 'Demo Concert',
        subtitle: 'An evening to try the seating plan, waiting room and cart',
        description:
          'This event was created by `pnpm db:demo`. Tickets cannot be paid yet (checkout follows in phase 3).',
        status: 'PUBLISHED',
        startsAt,
        doorsOpenAt: new Date(startsAt.getTime() - 3600_000),
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax.id,
        orphanSeatRuleEnabled: true,
        publishedAt: new Date(),
      })
      .returning();

    const categories = await db
      .insert(priceCategories)
      .values([
        { eventId: event!.id, name: 'Category 1', color: '#dc2626', basePrice: 5900, sortOrder: 1 },
        { eventId: event!.id, name: 'Category 2', color: '#2563eb', basePrice: 4500, sortOrder: 2 },
        { eventId: event!.id, name: 'Category 3', color: '#16a34a', basePrice: 2900, sortOrder: 3 },
      ])
      .returning();
    const types = await db
      .insert(ticketTypes)
      .values([
        { eventId: event!.id, name: 'Regular', isDefault: true, sortOrder: 1 },
        {
          eventId: event!.id,
          name: 'Reduced (students)',
          discountKind: 'PERCENT',
          discountValue: 3000,
          requiresProofAtEntry: true,
          scannerWarning: 'Check student ID',
          sortOrder: 2,
        },
        {
          eventId: event!.id,
          name: 'Wheelchair user',
          discountKind: 'PERCENT',
          discountValue: 5000,
          requiredSeatFeature: 'WHEELCHAIR_SPACE',
          requiresProofAtEntry: true,
          scannerWarning: 'Check disability card',
          sortOrder: 3,
        },
        {
          eventId: event!.id,
          name: 'Companion',
          discountKind: 'FIXED_PRICE',
          discountValue: 0,
          requiredSeatFeature: 'COMPANION_SEAT',
          requiresProofAtEntry: true,
          scannerWarning: 'Companion – check card of the wheelchair user',
          sortOrder: 4,
        },
      ])
      .returning();
    await db
      .insert(priceCategoryTicketTypes)
      .values(
        categories.flatMap((c) =>
          types.map((t) => ({ priceCategoryId: c.id, ticketTypeId: t.id })),
        ),
      );

    // Assign categories: front rows cat 1, back stalls cat 2, balcony + standing cat 3; FOH block.
    const doc = (await loadSeatMapDocument(db, eventMapId))!;
    const rowById = new Map(doc.rows.map((r) => [r.id, r]));
    const [cat1, cat2, cat3] = categories;
    for (const seat of doc.seats) {
      const row = rowById.get(seat.rowId!)!;
      seat.priceCategoryId =
        row.sortOrder <= 5 ? cat1!.id : row.sortOrder <= 12 ? cat2!.id : cat3!.id;
      if (row.sortOrder === 9 && (seat.position === 10 || seat.position === 11)) {
        seat.blockReason = 'TECHNICAL';
        seat.blockNote = 'Front-of-house desk';
      }
    }
    for (const section of doc.sections)
      if (section.type === 'STANDING') section.priceCategoryId = cat3!.id;
    const result = await saveSeatMapDocument(db, eventMapId, doc, null);
    if (!result.ok) throw new Error(`Event map save failed: ${result.error.message}`);
    console.log(
      `[demo] created "${event!.title}" with ${doc.seats.length} seats → /events/${EVENT_SLUG}`,
    );
  } finally {
    await handle.close();
  }
  await flushShopCacheBestEffort();
}

main().catch((err) => {
  console.error('[demo] failed', err);
  process.exit(1);
});
