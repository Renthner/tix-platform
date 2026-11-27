import { z } from 'zod';
import {
  DISCOUNT_KINDS,
  EMAIL_TEMPLATE_KEYS,
  EVENT_SEATING_MODES,
  FEE_CALCULATIONS,
  FEE_SCOPES,
  INFO_BOX_SIZES,
  PAYMENT_METHODS,
  QUEUE_ADMISSION_ORDERS,
  QUEUE_MODES,
  SALES_CHANNELS,
  SEAT_FEATURES,
  WAITLIST_TRIGGERS,
  type EventSeatingMode,
} from '../enums';
import { hexColorSchema } from '../schemas/common';
import {
  coverElementSchema,
  imageElementSchema,
  shapeElementSchema,
  textElementSchema,
  ticketQrSchema,
} from '../schemas/ticket-template';
import {
  planImageSchema,
  planSymbolSchema,
  seatMapFileSchema,
  type SeatMapFile,
} from '../seating/export-file';

/**
 * Portable event file (`*.tixevent.json`): the complete configuration of one event – settings,
 * translations, sales window, overrides, event page, seat plan, price categories, tariffs,
 * pricing matrix, fees, waiting room, event ticket templates and e-mail overrides – plus the
 * images it uses, but no database ids, orders, tickets, customers, access / discount codes,
 * signing keys or test orders. Everything refers to everything else by short local keys; the
 * importer creates fresh ids and a fresh signing key and always creates a DRAFT event.
 *
 * Nothing in the file is trusted: the importer validates it again, sanitises every HTML field
 * and re-checks images through the normal upload pipeline.
 */

export const EVENT_FILE_FORMAT = 'tix-event';
export const EVENT_FILE_VERSION = 1;
export const EVENT_FILE_MIN_VERSION = 1;
export const EVENT_FILE_EXTENSION = '.tixevent.json';
/** Hard cap of an uploaded event file (JSON text with base64 images); same as the seat plan file. */
export const EVENT_FILE_MAX_BYTES = 40 * 1024 * 1024;

const key = z.string().min(1).max(40);
const nullableKey = key.nullable().default(null);
const isoDate = z.iso.datetime({ offset: true });
const nullableDate = isoDate.nullable().default(null);
const posInt = z.number().int().positive().max(1_000_000_000);
const nullablePos = posInt.nullable().default(null);
const nullableBool = z.boolean().nullable().default(null);
/** Translations as stored; unsupported locales / unknown fields are dropped by the importer. */
const translations = z
  .record(z.string().max(16), z.record(z.string().min(1).max(64), z.string().max(50_000)))
  .default({});

const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

const taxRef = z.object({
  name: z.string().min(1).max(120),
  rateBasisPoints: z.number().int().min(0).max(10_000),
});

export const eventFileInfoBoxSchema = z.object({
  key,
  title: z.string().trim().max(120),
  /** Key into `symbols` of this file (icon from the symbol library). */
  symbolKey: nullableKey,
  content: z.string().max(50_000),
  textSize: z.enum(INFO_BOX_SIZES).nullable().default(null),
  iconSize: z.enum(INFO_BOX_SIZES).nullable().default(null),
  translations,
});

const pageLayoutItem = z.object({ ref: z.string().min(1).max(60), span: z.number().int() });

const eventSettings = z.object({
  title: z.string().trim().min(1).max(200),
  /**
   * SEATED (default – files written before admission-only events existed) or ADMISSION: the
   * seat plan then holds the contingents (STANDING sections) and the venue is optional.
   */
  seatingMode: z.enum(EVENT_SEATING_MODES).default('SEATED'),
  subtitle: z.string().max(300).nullable().default(null),
  description: z.string().max(50_000).nullable().default(null),
  translations,
  timeZone,
  currency: z.string().regex(/^[A-Z]{3}$/),
  taxRate: taxRef,
  startsAt: isoDate,
  doorsOpenAt: nullableDate,
  endsAt: nullableDate,
  presaleStartsAt: nullableDate,
  publicSaleStartsAt: nullableDate,
  saleEndsAt: nullableDate,
  seoNoindex: z.boolean().default(false),
  waitlistEnabled: nullableBool,
  waitlistTrigger: z.enum(WAITLIST_TRIGGERS).nullable().default(null),
  heroImageKey: nullableKey,
  ticketTemplateKey: nullableKey,
  // Overrides of global settings (null = inherit).
  maxTicketsPerOrder: nullablePos,
  maxTicketsPerCustomer: nullablePos,
  cartLockTtlSeconds: nullablePos,
  paymentGraceSeconds: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  manualSeatSelectionEnabled: nullableBool,
  bestAvailableEnabled: nullableBool,
  orphanSeatRuleEnabled: nullableBool,
  companionRequiresWheelchair: nullableBool,
  customerAccountsEnabled: nullableBool,
  selfServiceEnabled: nullableBool,
  selfServiceAllowNameChange: nullableBool,
  selfServiceAllowTransfer: nullableBool,
  selfServiceDeadlineHours: z.number().int().min(0).max(100_000).nullable().default(null),
  selfServiceMaxChanges: z.number().int().min(0).max(100_000).nullable().default(null),
  paypalEnabled: nullableBool,
  bankTransferEnabled: nullableBool,
  bankTransferPaymentTermDays: nullablePos,
  bankTransferReminderAfterDays: nullablePos,
  bankTransferCancelAfterDays: nullablePos,
  bankTransferAutoCancel: nullableBool,
  bankTransferDisableDaysBeforeEvent: z.number().int().min(0).max(100_000).nullable().default(null),
  /** Event page designer: rows of blocks (`box:<infoBoxKey>` for info boxes). */
  pageLayout: z.array(z.array(pageLayoutItem).max(10)).max(60).default([]),
  infoBoxes: z.array(eventFileInfoBoxSchema).max(6).default([]),
});

const filePriceCategory = z.object({
  key,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable().default(null),
  translations,
  color: hexColorSchema,
  basePrice: z.number().int().min(0).max(1_000_000_000),
  maxTicketsPerOrder: nullablePos,
  bestAvailableEnabled: z.boolean().default(true),
  ticketTemplateKey: nullableKey,
  sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
  isActive: z.boolean().default(true),
});

const channels = z.array(z.enum(SALES_CHANNELS)).min(1).max(3);
const fileTicketType = z.object({
  key,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable().default(null),
  translations,
  discountKind: z.enum(DISCOUNT_KINDS).default('NONE'),
  discountValue: z.number().int().min(0).max(1_000_000_000).default(0),
  requiresProofAtEntry: z.boolean().default(false),
  scannerWarning: z.string().max(500).nullable().default(null),
  requiredSeatFeature: z.enum(SEAT_FEATURES).nullable().default(null),
  maxPerOrder: nullablePos,
  channels: channels.default(['ONLINE', 'BOX_OFFICE', 'ADMIN']),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
});

const fileMatrixCell = z.object({
  categoryKey: key,
  typeKey: key,
  priceOverride: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  discountKind: z.enum(DISCOUNT_KINDS).nullable().default(null),
  discountValue: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  isActive: z.boolean().default(true),
});

const fileFee = z.object({
  name: z.string().trim().min(1).max(120),
  translations,
  scope: z.enum(FEE_SCOPES),
  calculation: z.enum(FEE_CALCULATIONS),
  value: z.number().int().min(0).max(1_000_000_000),
  taxRate: taxRef.nullable().default(null),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).max(10).nullable().default(null),
  channels: z.array(z.enum(SALES_CHANNELS)).max(3).nullable().default(null),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
  /** The event's adjustment of this global fee (matched by name and scope on import). */
  overridesGlobal: z
    .object({ name: z.string().max(120), scope: z.enum(FEE_SCOPES) })
    .nullable()
    .default(null),
});

const fileQueue = z.object({
  mode: z.enum(QUEUE_MODES),
  activeSessionThreshold: posInt,
  admissionBatchSize: posInt,
  admissionIntervalSeconds: posInt,
  passTokenTtlSeconds: z.number().int().min(60).max(1_000_000_000),
  lobbyOpensMinutesBefore: z.number().int().min(0).max(1_000_000),
  admissionOrder: z.enum(QUEUE_ADMISSION_ORDERS),
  accessCodeBypassesQueue: z.boolean(),
  maxQueueSize: nullablePos,
  title: z.string().max(200).nullable().default(null),
  message: z.string().max(2_000).nullable().default(null),
  translations,
});

const fileImageElement = imageElementSchema.omit({ assetId: true }).extend({ imageKey: key });
const fileTicketTemplate = z.object({
  key,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().default(null),
  pageWidthMm: z.number().min(20).max(2000),
  pageHeightMm: z.number().min(20).max(2000),
  backgroundImageKey: nullableKey,
  layout: z.object({
    version: z.literal(1),
    qr: ticketQrSchema,
    elements: z
      .array(
        z.discriminatedUnion('kind', [
          textElementSchema,
          fileImageElement,
          coverElementSchema,
          shapeElementSchema,
        ]),
      )
      .max(200),
  }),
});

const fileEmailTemplate = z.object({
  key: z.enum(EMAIL_TEMPLATE_KEYS),
  locale: z.string().min(2).max(16),
  subject: z.string().max(500),
  bodyHtml: z.string().max(200_000),
  bodyText: z.string().max(200_000).nullable().default(null),
  isActive: z.boolean().default(true),
});

export const eventFileSchema = z
  .object({
    format: z.literal(EVENT_FILE_FORMAT),
    version: z.literal(EVENT_FILE_VERSION),
    exportedAt: z.string().max(40),
    source: z.object({
      appVersion: z.string().max(40),
      venueName: z.string().max(200).nullable().default(null),
    }),
    event: eventSettings,
    priceCategories: z.array(filePriceCategory).max(200).default([]),
    ticketTypes: z.array(fileTicketType).max(100).default([]),
    pricing: z.array(fileMatrixCell).max(20_000).default([]),
    fees: z.array(fileFee).max(100).default([]),
    queue: fileQueue.nullable().default(null),
    ticketTemplates: z.array(fileTicketTemplate).max(50).default([]),
    emailTemplates: z.array(fileEmailTemplate).max(200).default([]),
    /** The event's seat plan in the seat plan file format (null = event without plan). */
    seatPlan: seatMapFileSchema.nullable().default(null),
    /** Library symbols used by info boxes (the plan carries its own). */
    symbols: z.array(planSymbolSchema).max(50).default([]),
    /** Images of the cover and the ticket templates, referenced by key. */
    images: z.array(planImageSchema.extend({ key })).max(60).default([]),
  })
  .superRefine((file, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const unique = (name: string, keys: string[]) => {
      if (new Set(keys).size !== keys.length) fail([name], 'Duplicate key');
    };
    unique(
      'priceCategories',
      file.priceCategories.map((c) => c.key),
    );
    unique(
      'ticketTypes',
      file.ticketTypes.map((c) => c.key),
    );
    unique(
      'ticketTemplates',
      file.ticketTemplates.map((c) => c.key),
    );
    unique(
      'images',
      file.images.map((c) => c.key),
    );
    unique(
      'symbols',
      file.symbols.map((c) => c.key),
    );
    unique(
      'infoBoxes',
      file.event.infoBoxes.map((c) => c.key),
    );
    // The database enforces these names as unique (case-sensitive).
    const dupNames = (name: string, names: string[]) => {
      if (new Set(names).size !== names.length) fail([name], 'Duplicate name');
    };
    dupNames(
      'priceCategories',
      file.priceCategories.map((c) => c.name),
    );
    dupNames(
      'ticketTypes',
      file.ticketTypes.map((c) => c.name),
    );
    unique(
      'emailTemplates',
      file.emailTemplates.map((m) => `${m.key}|${m.locale}`),
    );

    const categories = new Set(file.priceCategories.map((c) => c.key));
    const types = new Set(file.ticketTypes.map((c) => c.key));
    const templates = new Set(file.ticketTemplates.map((c) => c.key));
    const images = new Set(file.images.map((c) => c.key));
    if (file.ticketTypes.filter((t) => t.isDefault).length > 1) {
      fail(['ticketTypes'], 'More than one default tariff');
    }
    file.ticketTypes.forEach((t, i) => {
      if (t.discountKind === 'NONE' && t.discountValue !== 0)
        fail(['ticketTypes', i, 'discountValue'], 'No discount allowed here');
      if (t.discountKind === 'PERCENT' && t.discountValue > 10_000)
        fail(['ticketTypes', i, 'discountValue'], 'Percent out of range');
      if (t.requiresProofAtEntry && !t.scannerWarning)
        fail(['ticketTypes', i, 'scannerWarning'], 'A warning text is required');
    });
    file.pricing.forEach((cell, i) => {
      if (!categories.has(cell.categoryKey)) fail(['pricing', i, 'categoryKey'], 'Unknown key');
      if (!types.has(cell.typeKey)) fail(['pricing', i, 'typeKey'], 'Unknown key');
      if ((cell.discountKind === null) !== (cell.discountValue === null))
        fail(['pricing', i, 'discountKind'], 'Discount kind and value belong together');
      if (cell.priceOverride !== null && cell.discountKind !== null)
        fail(['pricing', i, 'priceOverride'], 'Price and discount are exclusive');
      if (cell.discountKind === 'PERCENT' && (cell.discountValue ?? 0) > 10_000)
        fail(['pricing', i, 'discountValue'], 'Percent out of range');
    });
    unique(
      'pricing',
      file.pricing.map((c) => `${c.categoryKey}|${c.typeKey}`),
    );
    file.priceCategories.forEach((c, i) => {
      if (c.ticketTemplateKey && !templates.has(c.ticketTemplateKey))
        fail(['priceCategories', i, 'ticketTemplateKey'], 'Unknown key');
    });
    const e = file.event;
    if (e.ticketTemplateKey && !templates.has(e.ticketTemplateKey))
      fail(['event', 'ticketTemplateKey'], 'Unknown key');
    if (e.heroImageKey && !images.has(e.heroImageKey))
      fail(['event', 'heroImageKey'], 'Unknown key');
    file.ticketTemplates.forEach((t, i) => {
      if (t.backgroundImageKey && !images.has(t.backgroundImageKey))
        fail(['ticketTemplates', i, 'backgroundImageKey'], 'Unknown key');
      t.layout.elements.forEach((el, j) => {
        if (el.kind === 'image' && !images.has(el.imageKey))
          fail(['ticketTemplates', i, 'layout', 'elements', j, 'imageKey'], 'Unknown key');
      });
    });
    file.event.infoBoxes.forEach((box, i) => {
      if (box.symbolKey && !file.symbols.some((s) => s.key === box.symbolKey))
        fail(['event', 'infoBoxes', i, 'symbolKey'], 'Unknown symbol key');
    });

    // Dates, as enforced by the database.
    const at = (v: string | null) => (v ? new Date(v).getTime() : null);
    const start = at(e.startsAt)!;
    const doors = at(e.doorsOpenAt);
    const end = at(e.endsAt);
    const presale = at(e.presaleStartsAt);
    const open = at(e.publicSaleStartsAt);
    const saleEnd = at(e.saleEndsAt);
    if (end !== null && end <= start) fail(['event', 'endsAt'], 'End must be after start');
    if (doors !== null && doors > start) fail(['event', 'doorsOpenAt'], 'Doors after start');
    if (presale !== null && open !== null && presale > open)
      fail(['event', 'presaleStartsAt'], 'Presale after public sale');
    const opens = open ?? presale;
    if (saleEnd !== null && opens !== null && saleEnd <= opens)
      fail(['event', 'saleEndsAt'], 'Sale ends before it starts');

    // The plan's categories must exist as price categories of the file.
    if (file.seatPlan) {
      const names = new Set(file.priceCategories.map((c) => c.name));
      file.seatPlan.categories.forEach((c, i) => {
        if (!names.has(c.name)) fail(['seatPlan', 'categories', i, 'name'], 'Unknown category');
      });
    }
  });
export type EventFile = z.infer<typeof eventFileSchema>;

/** Counts shown in the import preview. */
export interface EventFileSummary {
  title: string;
  subtitle: string | null;
  exportedAt: string;
  timeZone: string;
  startsAt: string;
  venueName: string | null;
  seatingMode: EventSeatingMode;
  priceCategories: number;
  ticketTypes: number;
  fees: number;
  infoBoxes: number;
  ticketTemplates: number;
  emailTemplates: number;
  hasCover: boolean;
  hasQueue: boolean;
  seatPlan: { seats: number; sections: number; standingSections: number } | null;
  taxRate: { name: string; rateBasisPoints: number };
  currency: string;
}

export function summarizeEventFile(file: EventFile): EventFileSummary {
  const plan: SeatMapFile | null = file.seatPlan;
  return {
    title: file.event.title,
    subtitle: file.event.subtitle,
    exportedAt: file.exportedAt,
    timeZone: file.event.timeZone,
    startsAt: file.event.startsAt,
    venueName: file.source.venueName,
    seatingMode: file.event.seatingMode,
    priceCategories: file.priceCategories.length,
    ticketTypes: file.ticketTypes.length,
    fees: file.fees.length,
    infoBoxes: file.event.infoBoxes.length,
    ticketTemplates: file.ticketTemplates.length,
    emailTemplates: file.emailTemplates.length,
    hasCover: file.event.heroImageKey !== null,
    hasQueue: file.queue !== null,
    seatPlan: plan
      ? {
          seats: plan.plan.seats.length,
          sections: plan.plan.sections.length,
          standingSections: plan.plan.sections.filter((s) => s.type === 'STANDING').length,
        }
      : null,
    taxRate: file.event.taxRate,
    currency: file.event.currency,
  };
}
