import { randomUUID } from 'node:crypto';
import {
  emailTemplates,
  events,
  fees,
  isUniqueViolation,
  priceCategories,
  priceCategoryTicketTypes,
  queueConfigs,
  svgSymbols,
  taxRates,
  ticketTemplates,
  ticketTypes,
  venues,
  withTransaction,
} from '@tix/db';
import {
  EVENT_FILE_FORMAT,
  EVENT_FILE_MAX_BYTES,
  EVENT_FILE_MIN_VERSION,
  EVENT_FILE_VERSION,
  SUPPORTED_LOCALES,
  TRANSLATABLE_FIELDS,
  cleanTranslations,
  eventFileSchema,
  isBlankText,
  normalizePageLayout,
  seatMapFileSchema,
  ticketLayoutSchema,
  type EventFile,
  type EventInfoBox,
  type MediaAssetKind,
  type PlanImage,
  type PlanSymbol,
  type Translations,
  type TranslatableEntity,
} from '@tix/shared';
import { asc, eq, inArray, isNull } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from './context';
import { eventTags, invalidateShopCache } from './cache/shop-cache';
import { prepareEmailTemplate } from './email/editor';
import { isTemplateKey, isTemplateLocale } from './email/template-admin';
import { deriveSlug, slugExists } from './event-duplicate';
import { deleteMediaAsset } from './media-admin';
import {
  assertPlanStructure,
  exportImage,
  exportSeatMap,
  prepareSymbols,
  resolveSymbols,
  uploadEmbeddedImage,
  uploadPlanImages,
  writeEventSeatMap,
} from './seatmaps/export-import';
import { insertEmptyEventSeatMap } from './seatmaps/replace';
import { ensureEventSigningKeyTx } from './tickets/keys';
import { wallClockShifter } from './zoned-time';

/**
 * Complete event export / import (`*.tixevent.json`, see `eventFileSchema`).
 *
 * Export is deterministic apart from `exportedAt` (entities are ordered and keyed "c1", "t2" …).
 * Import always creates a NEW DRAFT event with a fresh slug (on collision), fresh ids and a fresh
 * signing key; nothing from the file is trusted (strict validation, sanitised HTML, images through
 * the upload pipeline, library references resolved by name). Never exported: orders, tickets,
 * customers, access / discount codes, waitlist, signing keys, test orders, wallet design.
 */

const sortBy = <T>(items: T[], ...keys: ((item: T) => string | number)[]): T[] =>
  [...items].sort((a, b) => {
    for (const k of keys) {
      const x = k(a);
      const y = k(b);
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });

// ─── Export ─────────────────────────────────────────────────────────────────

export async function exportEvent(
  ctx: CoreContext,
  eventId: string,
  options: {
    appVersion?: string;
    /** E-mail overrides are included only for SUPER_ADMIN (the only role that edits templates). */
    includeEmailTemplates?: boolean;
  } = {},
): Promise<EventFile> {
  requireCapability(ctx, 'storage');
  const { db } = ctx;
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  const [venue] = event.venueId
    ? await db.select({ name: venues.name }).from(venues).where(eq(venues.id, event.venueId))
    : [];
  const [tax] = await db.select().from(taxRates).where(eq(taxRates.id, event.taxRateId));
  if (!tax) throw new DomainError('TAX_RATE_NOT_FOUND', 'Tax rate not found', 409);
  const taxRef = (t: { name: string; rateBasisPoints: number }) => ({
    name: t.name,
    rateBasisPoints: t.rateBasisPoints,
  });

  const [categoryRows, typeRows, templateRows, mailRows, feeRows, [queue]] = await Promise.all([
    db.select().from(priceCategories).where(eq(priceCategories.eventId, eventId)),
    db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId)),
    db.select().from(ticketTemplates).where(eq(ticketTemplates.eventId, eventId)),
    options.includeEmailTemplates
      ? db.select().from(emailTemplates).where(eq(emailTemplates.eventId, eventId))
      : Promise.resolve([] as (typeof emailTemplates.$inferSelect)[]),
    db.select().from(fees).where(eq(fees.eventId, eventId)),
    db.select().from(queueConfigs).where(eq(queueConfigs.eventId, eventId)),
  ]);

  const counters: Record<string, number> = {};
  const next = (prefix: string) => `${prefix}${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;

  const categories = sortBy(
    categoryRows,
    (c) => c.sortOrder,
    (c) => c.name,
  );
  const types = sortBy(
    typeRows,
    (t) => t.sortOrder,
    (t) => t.name,
  );
  const templates = sortBy(
    templateRows,
    (t) => t.name,
    (t) => t.createdAt.getTime(),
  );
  const categoryKey = new Map(categories.map((c) => [c.id, next('c')]));
  const typeKey = new Map(types.map((t) => [t.id, next('t')]));
  const templateKey = new Map(templates.map((t) => [t.id, next('tpl')]));

  const matrixRows = categories.length
    ? await db
        .select()
        .from(priceCategoryTicketTypes)
        .where(
          inArray(
            priceCategoryTicketTypes.priceCategoryId,
            categories.map((c) => c.id),
          ),
        )
    : [];

  // Images (cover + ticket templates)
  const images: (PlanImage & { key: string })[] = [];
  const imageKey = new Map<string, string>();
  const embed = async (assetId: string | null): Promise<string | null> => {
    if (!assetId) return null;
    let key = imageKey.get(assetId);
    if (!key) {
      key = next('img');
      imageKey.set(assetId, key);
      images.push({ key, ...(await exportImage(ctx, assetId)) });
    }
    return key;
  };
  const heroImageKey = await embed(event.heroImageAssetId);
  const templateFiles = [];
  for (const t of templates) {
    const elements = [];
    for (const el of t.layout.elements) {
      if (el.kind === 'image') {
        const { assetId, ...rest } = el;
        elements.push({ ...rest, imageKey: (await embed(assetId))! });
      } else elements.push(el);
    }
    templateFiles.push({
      key: templateKey.get(t.id)!,
      name: t.name,
      description: t.description,
      pageWidthMm: t.pageWidthMm,
      pageHeightMm: t.pageHeightMm,
      backgroundImageKey: await embed(t.backgroundAssetId),
      layout: { ...t.layout, elements },
    });
  }

  // Info boxes and their icons
  const boxes = event.infoBoxes;
  const boxKey = new Map(boxes.map((b) => [b.id, next('b')]));
  const symbolIds = [...new Set(boxes.map((b) => b.symbolId).filter((s): s is string => !!s))];
  const symbolRows = symbolIds.length
    ? sortBy(
        await db.select().from(svgSymbols).where(inArray(svgSymbols.id, symbolIds)),
        (s) => s.kind,
        (s) => s.name,
        (s) => s.markup,
      )
    : [];
  const symbolKey = new Map(symbolRows.map((s) => [s.id, next('sym')]));
  const symbols: PlanSymbol[] = symbolRows.map((s) => ({
    key: symbolKey.get(s.id)!,
    name: s.name,
    kind: s.kind,
    viewBox: s.viewBox,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.viewBox}">${s.markup}</svg>`,
    colorize: s.colorize,
    builtinKey: s.builtinKey,
  }));
  const layout = normalizePageLayout(
    event.pageLayout,
    boxes.map((b) => b.id),
  ).map((row) =>
    row.map((item) => ({
      ref: item.ref.startsWith('box:') ? `box:${boxKey.get(item.ref.slice(4)) ?? ''}` : item.ref,
      span: item.span,
    })),
  );

  // Fees: an event adjustment names the global fee it overrides.
  const globalIds = [
    ...new Set(feeRows.map((f) => f.overridesFeeId).filter((i): i is string => !!i)),
  ];
  const globals = globalIds.length
    ? await db.select().from(fees).where(inArray(fees.id, globalIds))
    : [];
  const taxIds = [...new Set(feeRows.map((f) => f.taxRateId).filter((i): i is string => !!i))];
  const feeTaxes = taxIds.length
    ? await db.select().from(taxRates).where(inArray(taxRates.id, taxIds))
    : [];

  const seatPlan = event.seatMapId
    ? await exportSeatMap(ctx, event.seatMapId, { appVersion: options.appVersion })
    : null;

  const e = event;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const file = {
    format: EVENT_FILE_FORMAT,
    version: EVENT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    source: { appVersion: options.appVersion ?? 'unknown', venueName: venue?.name ?? null },
    event: {
      title: e.title,
      seatingMode: e.seatingMode,
      subtitle: e.subtitle,
      description: e.description,
      translations: e.translations,
      timeZone: e.timeZone,
      currency: e.currency,
      taxRate: taxRef(tax),
      startsAt: e.startsAt.toISOString(),
      doorsOpenAt: iso(e.doorsOpenAt),
      endsAt: iso(e.endsAt),
      presaleStartsAt: iso(e.presaleStartsAt),
      publicSaleStartsAt: iso(e.publicSaleStartsAt),
      saleEndsAt: iso(e.saleEndsAt),
      seoNoindex: e.seoNoindex,
      waitlistEnabled: e.waitlistEnabled,
      waitlistTrigger: e.waitlistTrigger,
      heroImageKey,
      ticketTemplateKey: e.ticketTemplateId ? (templateKey.get(e.ticketTemplateId) ?? null) : null,
      maxTicketsPerOrder: e.maxTicketsPerOrder,
      maxTicketsPerCustomer: e.maxTicketsPerCustomer,
      cartLockTtlSeconds: e.cartLockTtlSeconds,
      paymentGraceSeconds: e.paymentGraceSeconds,
      manualSeatSelectionEnabled: e.manualSeatSelectionEnabled,
      bestAvailableEnabled: e.bestAvailableEnabled,
      orphanSeatRuleEnabled: e.orphanSeatRuleEnabled,
      companionRequiresWheelchair: e.companionRequiresWheelchair,
      customerAccountsEnabled: e.customerAccountsEnabled,
      selfServiceEnabled: e.selfServiceEnabled,
      selfServiceAllowNameChange: e.selfServiceAllowNameChange,
      selfServiceAllowTransfer: e.selfServiceAllowTransfer,
      selfServiceDeadlineHours: e.selfServiceDeadlineHours,
      selfServiceMaxChanges: e.selfServiceMaxChanges,
      paypalEnabled: e.paypalEnabled,
      bankTransferEnabled: e.bankTransferEnabled,
      bankTransferPaymentTermDays: e.bankTransferPaymentTermDays,
      bankTransferReminderAfterDays: e.bankTransferReminderAfterDays,
      bankTransferCancelAfterDays: e.bankTransferCancelAfterDays,
      bankTransferAutoCancel: e.bankTransferAutoCancel,
      bankTransferDisableDaysBeforeEvent: e.bankTransferDisableDaysBeforeEvent,
      pageLayout: layout,
      infoBoxes: boxes.map((b) => ({
        key: boxKey.get(b.id)!,
        title: b.title,
        symbolKey: b.symbolId ? (symbolKey.get(b.symbolId) ?? null) : null,
        content: b.content,
        textSize: b.textSize ?? null,
        iconSize: b.iconSize ?? null,
        translations: b.translations ?? {},
      })),
    },
    priceCategories: categories.map((c) => ({
      key: categoryKey.get(c.id)!,
      name: c.name,
      description: c.description,
      translations: c.translations,
      color: c.color,
      basePrice: c.basePrice,
      maxTicketsPerOrder: c.maxTicketsPerOrder,
      bestAvailableEnabled: c.bestAvailableEnabled,
      ticketTemplateKey: c.ticketTemplateId ? (templateKey.get(c.ticketTemplateId) ?? null) : null,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
    })),
    ticketTypes: types.map((t) => ({
      key: typeKey.get(t.id)!,
      name: t.name,
      description: t.description,
      translations: t.translations,
      discountKind: t.discountKind,
      discountValue: t.discountValue,
      requiresProofAtEntry: t.requiresProofAtEntry,
      scannerWarning: t.scannerWarning,
      requiredSeatFeature: t.requiredSeatFeature,
      maxPerOrder: t.maxPerOrder,
      channels: t.channels,
      isDefault: t.isDefault,
      isActive: t.isActive,
      sortOrder: t.sortOrder,
    })),
    pricing: sortBy(
      matrixRows,
      (m) => categoryKey.get(m.priceCategoryId) ?? '',
      (m) => typeKey.get(m.ticketTypeId) ?? '',
    ).map((m) => ({
      categoryKey: categoryKey.get(m.priceCategoryId)!,
      typeKey: typeKey.get(m.ticketTypeId)!,
      priceOverride: m.priceOverride,
      discountKind: m.discountKind,
      discountValue: m.discountValue,
      isActive: m.isActive,
    })),
    fees: sortBy(
      feeRows,
      (f) => f.sortOrder,
      (f) => f.name,
    ).map((f) => {
      const global = f.overridesFeeId ? globals.find((g) => g.id === f.overridesFeeId) : undefined;
      const feeTax = f.taxRateId ? feeTaxes.find((t) => t.id === f.taxRateId) : undefined;
      return {
        name: f.name,
        translations: f.translations,
        scope: f.scope,
        calculation: f.calculation,
        value: f.value,
        taxRate: feeTax ? taxRef(feeTax) : null,
        paymentMethods: f.paymentMethods,
        channels: f.channels,
        isActive: f.isActive,
        sortOrder: f.sortOrder,
        overridesGlobal: global ? { name: global.name, scope: global.scope } : null,
      };
    }),
    queue: queue
      ? {
          mode: queue.mode,
          activeSessionThreshold: queue.activeSessionThreshold,
          admissionBatchSize: queue.admissionBatchSize,
          admissionIntervalSeconds: queue.admissionIntervalSeconds,
          passTokenTtlSeconds: queue.passTokenTtlSeconds,
          lobbyOpensMinutesBefore: queue.lobbyOpensMinutesBefore,
          admissionOrder: queue.admissionOrder,
          accessCodeBypassesQueue: queue.accessCodeBypassesQueue,
          maxQueueSize: queue.maxQueueSize,
          title: queue.title,
          message: queue.message,
          translations: queue.translations,
        }
      : null,
    ticketTemplates: templateFiles,
    emailTemplates: sortBy(
      mailRows,
      (m) => m.key,
      (m) => m.locale,
    ).map((m) => ({
      key: m.key,
      locale: m.locale,
      subject: m.subject,
      bodyHtml: m.bodyHtml,
      bodyText: m.bodyText,
      isActive: m.isActive,
    })),
    seatPlan,
    symbols,
    images,
  };
  return eventFileSchema.parse(file);
}

// ─── Parse ──────────────────────────────────────────────────────────────────

/** Parses and validates the text of an uploaded event file. */
export function parseEventFile(text: string | Uint8Array): EventFile {
  const size = typeof text === 'string' ? Buffer.byteLength(text) : text.byteLength;
  if (size > EVENT_FILE_MAX_BYTES) {
    throw new DomainError('EVENT_FILE_TOO_LARGE', 'The event file is too large', 413);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
  } catch {
    throw new DomainError('EVENT_FILE_INVALID', 'The file is not an event file', 422);
  }
  const head = raw as { format?: unknown; version?: unknown } | null;
  if (!head || typeof head !== 'object' || head.format !== EVENT_FILE_FORMAT) {
    throw new DomainError('EVENT_FILE_INVALID', 'The file is not an event file', 422);
  }
  if (
    typeof head.version !== 'number' ||
    head.version < EVENT_FILE_MIN_VERSION ||
    head.version > EVENT_FILE_VERSION
  ) {
    throw new DomainError(
      'EVENT_VERSION_UNSUPPORTED',
      'This event file version is not supported',
      422,
    );
  }
  const parsed = eventFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError('EVENT_FILE_INVALID', 'The event file is invalid', 422, {
      issues: parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

// ─── Import ─────────────────────────────────────────────────────────────────

export type EventImportWarning =
  | { code: 'TAX_RATE_FALLBACK'; name: string }
  | { code: 'FEE_SKIPPED'; name: string }
  | {
      code: 'EMAIL_TEMPLATE_SKIPPED';
      key: string;
      locale: string;
      /** role: importer is not SUPER_ADMIN; locale/key: unsupported; invalid: failed validation. */
      reason: 'role' | 'locale' | 'key' | 'invalid';
    };

export interface ImportEventInput {
  file: unknown;
  /**
   * Venue of the new event (its seat plan belongs to it). Required for seated events, optional
   * for admission-only ones (`event.seatingMode` ADMISSION in the file).
   */
  venueId: string | null;
  userId: string | null;
  /** Defaults to the title in the file. */
  title?: string;
  /** Shop slug; derived from the title with a numeric suffix on collision when omitted. */
  slug?: string | null;
  /** New start; every other date keeps its wall-clock distance to it. Default: dates as in the file. */
  startsAt?: Date | null;
  /** Rich-text sanitiser of the web layer (applied to every HTML field of the file). */
  sanitizeRichText: (html: string) => string;
  /**
   * E-mail overrides are imported only when the acting user may edit e-mail templates
   * (SUPER_ADMIN); otherwise they are skipped with a warning. Default: skipped.
   */
  includeEmailTemplates?: boolean;
  /** Name of the default tariff created when the file has none (translated by the caller). */
  defaultTicketTypeName: string;
}

export interface ImportEventResult {
  eventId: string;
  slug: string;
  warnings: EventImportWarning[];
  seatPlan: { seats: number; categoriesCreated: number; unassigned: number } | null;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function importEvent(
  ctx: CoreContext,
  input: ImportEventInput,
): Promise<ImportEventResult> {
  requireCapability(ctx, 'storage');
  const file = eventFileSchema.parse(input.file);
  const src = file.event;

  const title = (input.title ?? src.title).trim();
  if (!title || title.length > 200) throw new DomainError('INVALID_TITLE', 'Invalid title', 400);
  const explicitSlug = input.slug?.trim() || null;
  if (explicitSlug && (explicitSlug.length > 80 || !SLUG.test(explicitSlug))) {
    throw new DomainError('INVALID_SLUG', 'Invalid slug', 400);
  }

  // Dates: as in the file, or shifted to the new start keeping local times of day.
  const fileStart = new Date(src.startsAt);
  const start = input.startsAt ?? fileStart;
  const shift = input.startsAt
    ? wallClockShifter(fileStart, input.startsAt, src.timeZone)
    : (d: Date | null) => d;
  const date = (v: string | null) => shift(v ? new Date(v) : null);
  const dates = {
    doorsOpenAt: date(src.doorsOpenAt),
    endsAt: date(src.endsAt),
    presaleStartsAt: date(src.presaleStartsAt),
    publicSaleStartsAt: date(src.publicSaleStartsAt),
    saleEndsAt: date(src.saleEndsAt),
  };
  const opens = dates.publicSaleStartsAt ?? dates.presaleStartsAt;
  if (
    (dates.endsAt && dates.endsAt <= start) ||
    (dates.doorsOpenAt && dates.doorsOpenAt > start) ||
    (dates.presaleStartsAt &&
      dates.publicSaleStartsAt &&
      dates.presaleStartsAt > dates.publicSaleStartsAt) ||
    (dates.saleEndsAt && opens && dates.saleEndsAt <= opens)
  ) {
    throw new DomainError('INVALID_DATES', 'The dates of the event are inconsistent', 400);
  }

  // Everything that can fail on its own is checked before any image is stored.
  const infoSymbols = prepareSymbols(file.symbols);
  const plan = file.seatPlan ? seatMapFileSchema.parse(file.seatPlan) : null;
  const planSymbols = plan ? prepareSymbols(plan.symbols) : [];
  if (plan) assertPlanStructure(plan);
  // Files written before admission-only events existed carry no mode: SEATED.
  const admission = src.seatingMode === 'ADMISSION';
  if (!admission && !input.venueId) {
    throw new DomainError('VENUE_REQUIRED', 'A seated event needs a venue', 422, {
      field: 'venueId',
    });
  }
  if (
    admission &&
    plan &&
    (plan.plan.seats.length > 0 || plan.plan.sections.some((s) => s.type !== 'STANDING'))
  ) {
    throw new DomainError(
      'EVENT_FILE_INVALID',
      'The contingents of an admission-only event must be standing sections without seats',
      422,
    );
  }
  const layouts = file.ticketTemplates.map((t) => ({ key: t.key, layout: t.layout }));
  for (const t of layouts) {
    // Image keys are replaced by (placeholder) ids only to run the layout through its schema.
    ticketLayoutSchema.parse({
      ...t.layout,
      elements: t.layout.elements.map((el) =>
        el.kind === 'image' ? { ...stripKey(el), assetId: randomUUID() } : el,
      ),
    });
  }

  const created: string[] = [];
  let committed = false;
  try {
    // Images by usage: cover → EVENT_IMAGE, ticket artwork → TICKET_BACKGROUND (never from the file).
    const uploads = new Map<string, string>();
    const upload = async (key: string, kind: MediaAssetKind): Promise<string> => {
      const memo = `${kind}:${key}`;
      let id = uploads.get(memo);
      if (!id) {
        const image = file.images.find((i) => i.key === key)!;
        id = await uploadEmbeddedImage(ctx, image, kind, input.userId, created);
        uploads.set(memo, id);
      }
      return id;
    };
    const heroAssetId = src.heroImageKey ? await upload(src.heroImageKey, 'EVENT_IMAGE') : null;
    const templateAssets = new Map<
      string,
      { background: string | null; images: Map<string, string> }
    >();
    for (const t of file.ticketTemplates) {
      const images = new Map<string, string>();
      for (const el of t.layout.elements) {
        if (el.kind === 'image' && !images.has(el.imageKey)) {
          images.set(el.imageKey, await upload(el.imageKey, 'TICKET_BACKGROUND'));
        }
      }
      templateAssets.set(t.key, {
        background: t.backgroundImageKey
          ? await upload(t.backgroundImageKey, 'TICKET_BACKGROUND')
          : null,
        images,
      });
    }
    const planUploads = plan ? await uploadPlanImages(ctx, plan, input.userId, created) : null;

    const result = await withTransaction(ctx.db, async (tx): Promise<ImportEventResult> => {
      const warnings: EventImportWarning[] = [];
      if (input.venueId) {
        const [venue] = await tx
          .select({ id: venues.id })
          .from(venues)
          .where(eq(venues.id, input.venueId));
        if (!venue) throw new DomainError('NOT_FOUND', 'Venue not found', 404);
      }

      // Slug: explicit → must be free; derived → numeric suffix on collision.
      let slug = explicitSlug ?? deriveSlug(title);
      if (explicitSlug) {
        if (await slugExists(tx, slug)) throw new DomainError('SLUG_TAKEN', 'Slug taken', 409);
      } else {
        const base = slug;
        for (let n = 2; await slugExists(tx, slug); n += 1) slug = `${base.slice(0, 76)}-${n}`;
      }

      // Tax rates are matched by name AND rate (active only); anything else falls back to the default rate.
      const taxList = await tx.select().from(taxRates).orderBy(asc(taxRates.sortOrder));
      const fallbackTax = (
        taxList.find((t) => t.isDefault && !t.archivedAt) ?? taxList.find((t) => !t.archivedAt)
      )?.id;
      const taxFor = (ref: { name: string; rateBasisPoints: number }): string | null => {
        const found = taxList.find(
          (t) => !t.archivedAt && t.name === ref.name && t.rateBasisPoints === ref.rateBasisPoints,
        )?.id;
        if (found) return found;
        warnings.push({ code: 'TAX_RATE_FALLBACK', name: ref.name });
        return fallbackTax ?? null;
      };
      const taxRateId = taxFor(src.taxRate);
      if (!taxRateId) throw new DomainError('TAX_RATE_NOT_FOUND', 'No tax rate configured', 409);

      // Info boxes: fresh ids, icons resolved in the symbol library, HTML sanitised.
      const symbolIds = (await resolveSymbols(tx, infoSymbols, input.userId)).ids;
      const boxIds = new Map(src.infoBoxes.map((b) => [b.key, randomUUID()]));
      const infoBoxes: EventInfoBox[] = src.infoBoxes.map((b) => {
        const box: EventInfoBox = {
          id: boxIds.get(b.key)!,
          title: b.title,
          symbolId: b.symbolKey ? (symbolIds.get(b.symbolKey) ?? null) : null,
          content: input.sanitizeRichText(b.content),
        };
        if (b.textSize) box.textSize = b.textSize;
        if (b.iconSize) box.iconSize = b.iconSize;
        const tr = cleanTr(b.translations, 'infoBox', input.sanitizeRichText);
        if (Object.keys(tr).length) box.translations = tr;
        return box;
      });
      const pageLayout = normalizePageLayout(
        src.pageLayout.map((row) =>
          row.map((item) => ({
            ref: item.ref.startsWith('box:')
              ? `box:${boxIds.get(item.ref.slice(4)) ?? ''}`
              : item.ref,
            span: item.span,
          })),
        ),
        [...boxIds.values()],
      );

      const description = input.sanitizeRichText(src.description ?? '');
      const eventId = randomUUID();
      const { translations: _t, ...overrides } = pickOverrides(src);
      await tx.insert(events).values({
        ...overrides,
        id: eventId,
        venueId: input.venueId,
        seatingMode: src.seatingMode,
        seatMapId: null,
        slug,
        title,
        subtitle: src.subtitle?.trim() || null,
        description: isBlankText(description) ? null : description,
        translations: cleanTr(
          title === src.title ? src.translations : withoutField(src.translations, 'title'),
          'event',
          input.sanitizeRichText,
        ),
        status: 'DRAFT',
        timeZone: src.timeZone,
        currency: src.currency,
        taxRateId,
        startsAt: start,
        ...dates,
        pageLayout,
        infoBoxes,
        heroImageAssetId: heroAssetId,
        createdByUserId: input.userId,
      });

      // ── Ticket templates (event-scoped) ───────────────────────────────
      const templateIds = new Map(file.ticketTemplates.map((t) => [t.key, randomUUID()]));
      for (const t of file.ticketTemplates) {
        const assets = templateAssets.get(t.key)!;
        const layout = ticketLayoutSchema.parse({
          ...t.layout,
          elements: t.layout.elements.map((el) =>
            el.kind === 'image'
              ? { ...stripKey(el), assetId: assets.images.get(el.imageKey)! }
              : el,
          ),
        });
        await tx.insert(ticketTemplates).values({
          id: templateIds.get(t.key)!,
          eventId,
          name: t.name,
          description: t.description,
          pageWidthMm: t.pageWidthMm,
          pageHeightMm: t.pageHeightMm,
          backgroundAssetId: assets.background,
          layout,
          createdByUserId: input.userId,
        });
      }
      if (src.ticketTemplateKey) {
        await tx
          .update(events)
          .set({ ticketTemplateId: templateIds.get(src.ticketTemplateKey)! })
          .where(eq(events.id, eventId));
      }

      // ── Price categories, tariffs, matrix ─────────────────────────────
      const categoryIds = new Map(file.priceCategories.map((c) => [c.key, randomUUID()]));
      if (file.priceCategories.length > 0) {
        await tx.insert(priceCategories).values(
          file.priceCategories.map((c) => ({
            id: categoryIds.get(c.key)!,
            eventId,
            name: c.name,
            description: c.description,
            translations: cleanTr(c.translations, 'priceCategory', input.sanitizeRichText),
            color: c.color,
            basePrice: c.basePrice,
            maxTicketsPerOrder: c.maxTicketsPerOrder,
            bestAvailableEnabled: c.bestAvailableEnabled,
            ticketTemplateId: c.ticketTemplateKey ? templateIds.get(c.ticketTemplateKey)! : null,
            sortOrder: c.sortOrder,
            isActive: c.isActive,
          })),
        );
      }
      const typeIds = new Map(file.ticketTypes.map((t) => [t.key, randomUUID()]));
      if (file.ticketTypes.length > 0) {
        await tx.insert(ticketTypes).values(
          file.ticketTypes.map((t) => ({
            id: typeIds.get(t.key)!,
            eventId,
            name: t.name,
            description: t.description,
            translations: cleanTr(t.translations, 'ticketType', input.sanitizeRichText),
            discountKind: t.discountKind,
            discountValue: t.discountValue,
            requiresProofAtEntry: t.requiresProofAtEntry,
            scannerWarning: t.scannerWarning,
            requiredSeatFeature: t.requiredSeatFeature,
            maxPerOrder: t.maxPerOrder,
            channels: t.channels,
            isDefault: t.isDefault,
            isActive: t.isActive,
            sortOrder: t.sortOrder,
          })),
        );
      } else {
        await tx
          .insert(ticketTypes)
          .values({ eventId, name: input.defaultTicketTypeName.slice(0, 80), isDefault: true });
      }
      if (file.pricing.length > 0) {
        await tx.insert(priceCategoryTicketTypes).values(
          file.pricing.map((m) => ({
            priceCategoryId: categoryIds.get(m.categoryKey)!,
            ticketTypeId: typeIds.get(m.typeKey)!,
            priceOverride: m.priceOverride,
            discountKind: m.discountKind,
            discountValue: m.discountValue,
            isActive: m.isActive,
          })),
        );
      }

      // ── Fees ──────────────────────────────────────────────────────────
      const globalFees = await tx.select().from(fees).where(isNull(fees.eventId));
      const overridden = new Set<string>();
      for (const f of file.fees) {
        let overridesFeeId: string | null = null;
        if (f.overridesGlobal) {
          const { name, scope } = f.overridesGlobal;
          const global = globalFees.find((g) => g.name === name && g.scope === scope);
          // Without its global fee an adjustment has no meaning (it would waive nothing).
          if (!global || overridden.has(global.id)) {
            warnings.push({ code: 'FEE_SKIPPED', name: f.name });
            continue;
          }
          overridden.add(global.id);
          overridesFeeId = global.id;
        }
        if (f.scope === 'PER_ORDER') {
          // Per-order fees exist only globally.
          warnings.push({ code: 'FEE_SKIPPED', name: f.name });
          continue;
        }
        await tx.insert(fees).values({
          eventId,
          overridesFeeId,
          name: f.name,
          translations: cleanTr(f.translations, 'fee', input.sanitizeRichText),
          scope: f.scope,
          calculation: f.calculation,
          value: f.value,
          taxRateId: f.taxRate ? taxFor(f.taxRate) : null,
          paymentMethods: f.paymentMethods,
          channels: f.channels,
          isActive: f.isActive,
          sortOrder: f.sortOrder,
        });
      }

      // ── Waiting room, e-mail overrides ────────────────────────────────
      if (file.queue) {
        const q = file.queue;
        await tx.insert(queueConfigs).values({
          ...q,
          eventId,
          translations: cleanTr(q.translations, 'queueConfig', input.sanitizeRichText),
          updatedByUserId: input.userId,
        });
      }
      for (const m of file.emailTemplates) {
        const skip = (reason: 'role' | 'locale' | 'key' | 'invalid') =>
          warnings.push({ code: 'EMAIL_TEMPLATE_SKIPPED', key: m.key, locale: m.locale, reason });
        if (!input.includeEmailTemplates) {
          skip('role');
          continue;
        }
        if (!isTemplateLocale(m.locale)) {
          skip('locale');
          continue;
        }
        if (!isTemplateKey(m.key)) {
          skip('key');
          continue;
        }
        // Same preparation and validation as the template editor.
        const { draft, validation } = prepareEmailTemplate(
          m.key,
          { subject: m.subject, bodyHtml: m.bodyHtml, bodyText: m.bodyText },
          { baseUrl: ctx.appUrl ?? null },
        );
        if (validation.errors.length > 0 || !draft.subject || !draft.bodyHtml) {
          skip('invalid');
          continue;
        }
        await tx.insert(emailTemplates).values({
          key: m.key,
          eventId,
          locale: m.locale,
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          bodyText: draft.bodyText,
          isActive: m.isActive,
          updatedByUserId: input.userId,
        });
      }

      // ── Seat plan (uses the price categories created above) ───────────
      let seatPlan: ImportEventResult['seatPlan'] = null;
      if (plan) {
        const written = await writeEventSeatMap(tx, {
          eventId,
          // The hidden contingent plan of an admission-only event never belongs to a venue.
          venueId: admission ? null : input.venueId,
          admission,
          file: plan,
          prepared: planSymbols,
          imageIds: planUploads!.imageIds,
          backgroundAssetId: planUploads!.backgroundAssetId,
          userId: input.userId,
          name: title.slice(0, 120),
        });
        seatPlan = {
          seats: written.seats,
          categoriesCreated: written.categoriesCreated,
          unassigned: written.unassigned,
        };
      } else if (admission) {
        // Contingents are edited on the event: an admission-only event always has its hidden plan.
        const seatMapId = await insertEmptyEventSeatMap(tx, {
          venueId: null,
          name: title.slice(0, 120),
        });
        await tx.update(events).set({ seatMapId }).where(eq(events.id, eventId));
      }

      // ── Fresh Ed25519 signing key (never part of a file) ──────────────
      if (ctx.secrets) await ensureEventSigningKeyTx(ctx, tx, eventId);

      return { eventId, slug, warnings, seatPlan };
    });
    committed = true;
    await invalidateShopCache(ctx, eventTags(result.eventId));
    return result;
  } catch (err) {
    if (!committed) for (const id of created) await deleteMediaAsset(ctx, id).catch(() => {});
    if (isUniqueViolation(err, 'events_slug_uq')) {
      throw new DomainError('SLUG_TAKEN', 'Slug taken', 409);
    }
    throw err;
  }
}

/** The configuration columns of the file that map 1:1 onto the event row. */
function pickOverrides(src: EventFile['event']) {
  return {
    translations: src.translations,
    seoNoindex: src.seoNoindex,
    waitlistEnabled: src.waitlistEnabled,
    waitlistTrigger: src.waitlistTrigger,
    maxTicketsPerOrder: src.maxTicketsPerOrder,
    maxTicketsPerCustomer: src.maxTicketsPerCustomer,
    cartLockTtlSeconds: src.cartLockTtlSeconds,
    paymentGraceSeconds: src.paymentGraceSeconds,
    manualSeatSelectionEnabled: src.manualSeatSelectionEnabled,
    bestAvailableEnabled: src.bestAvailableEnabled,
    orphanSeatRuleEnabled: src.orphanSeatRuleEnabled,
    companionRequiresWheelchair: src.companionRequiresWheelchair,
    // The admin form only ever stores false / null for these two.
    customerAccountsEnabled: src.customerAccountsEnabled === false ? false : null,
    selfServiceEnabled: src.selfServiceEnabled,
    selfServiceAllowNameChange: src.selfServiceAllowNameChange,
    selfServiceAllowTransfer: src.selfServiceAllowTransfer,
    selfServiceDeadlineHours: src.selfServiceDeadlineHours,
    selfServiceMaxChanges: src.selfServiceMaxChanges,
    paypalEnabled: src.paypalEnabled,
    bankTransferEnabled: src.bankTransferEnabled,
    bankTransferPaymentTermDays: src.bankTransferPaymentTermDays,
    bankTransferReminderAfterDays: src.bankTransferReminderAfterDays,
    bankTransferCancelAfterDays: src.bankTransferCancelAfterDays,
    bankTransferAutoCancel: src.bankTransferAutoCancel === false ? false : null,
    bankTransferDisableDaysBeforeEvent: src.bankTransferDisableDaysBeforeEvent,
  };
}

function stripKey<T extends { imageKey: string }>(el: T): Omit<T, 'imageKey'> {
  const { imageKey: _k, ...rest } = el;
  return rest;
}

function withoutField(translations: Translations, field: string): Translations {
  const out: Translations = {};
  for (const [locale, fields] of Object.entries(translations)) {
    const { [field]: _removed, ...rest } = fields ?? {};
    if (Object.keys(rest).length) out[locale] = rest;
  }
  return out;
}

/**
 * Translations from a file: unsupported locales and unknown fields are dropped, rich-text
 * fields go through the sanitiser, blank values are removed.
 */
function cleanTr(
  input: Record<string, Record<string, string> | undefined>,
  entity: TranslatableEntity,
  sanitize: (html: string) => string,
): Translations {
  const rich = new Set<string>(
    TRANSLATABLE_FIELDS[entity].filter((f) => f.rich).map((f) => f.name),
  );
  const supported = new Set<string>(SUPPORTED_LOCALES);
  const prepared: Record<string, Record<string, string>> = {};
  for (const [locale, fields] of Object.entries(input ?? {})) {
    if (!supported.has(locale) || !fields) continue;
    prepared[locale] = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, rich.has(k) ? sanitize(v) : v]),
    );
  }
  return cleanTranslations(prepared, entity);
}
