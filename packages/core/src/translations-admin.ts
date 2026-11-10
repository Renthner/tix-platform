import {
  events,
  fees,
  priceCategories,
  queueConfigs,
  seatMapElements,
  seatMapEntrances,
  seatMapSections,
  ticketTypes,
  venues,
  withTransaction,
} from '@tix/db';
import {
  SUPPORTED_LOCALES,
  TRANSLATABLE_FIELDS,
  isBlankText,
  mergeLocaleTranslations,
  normalizeLocale,
  translationCompleteness,
  translationLocales,
  type EventInfoBox,
  type TranslatableEntity,
  type Translations,
} from '@tix/shared';
import { and, eq, isNull, or } from 'drizzle-orm';
import { DomainError, type CoreContext } from './context';
import { invalidatePublicSeatMap, seatMapVersion } from './seatmaps/public';
import { getSetting } from './settings';

/**
 * Admin side of content translations. The editor of an event tab (event, pricing, fees, shop
 * page, waiting room) loads the translatable texts of that tab for one locale and saves them
 * back. A save only merges the given locale into the `translations` of each row - other locales
 * and every base column stay untouched.
 */

/** Tabs of the event admin with translatable texts (the seating plan has its own editor). */
export const TRANSLATION_SCOPES = ['event', 'pricing', 'fees', 'shopPage', 'waitingRoom'] as const;
export type TranslationScope = (typeof TRANSLATION_SCOPES)[number];

export interface TranslationFieldView {
  name: string;
  rich: boolean;
  max: number;
  /** Base text (shop default language). */
  base: string;
  /** Current translation of the edited locale ('' = not translated). */
  value: string;
}

export interface TranslationItemView {
  entity: TranslatableEntity;
  id: string;
  /** Short caption of the row (base name). */
  label: string;
  fields: TranslationFieldView[];
}

export interface TranslationGroupView {
  /** Message key suffix under `translations.groups`. */
  key: string;
  items: TranslationItemView[];
  /** Shown for context only (global fees inside an event: edited under Fees). */
  readOnly?: boolean;
}

export interface TranslationUpdate {
  entity: TranslatableEntity;
  id: string;
  fields: Record<string, string>;
}

const SCOPE_ENTITIES: Record<TranslationScope, TranslatableEntity[]> = {
  event: ['event', 'venue'],
  pricing: ['priceCategory', 'ticketType'],
  fees: ['fee'],
  shopPage: ['infoBox'],
  waitingRoom: ['queueConfig'],
};

interface RawItem {
  entity: TranslatableEntity;
  group: string;
  id: string;
  label: string;
  translations: Translations;
  base: Record<string, string | null>;
}

/** All translatable rows of an event with their base texts, grouped per tab. */
async function collectItems(
  ctx: CoreContext,
  eventId: string,
): Promise<{ scope: TranslationScope; item: RawItem }[]> {
  const db = ctx.db;
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  const [venue] = await db.select().from(venues).where(eq(venues.id, event.venueId));
  const [categories, types, feeRows, queue] = await Promise.all([
    db.select().from(priceCategories).where(eq(priceCategories.eventId, eventId)),
    db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId)),
    db
      .select()
      .from(fees)
      .where(or(eq(fees.eventId, eventId), isNull(fees.eventId))),
    db.select().from(queueConfigs).where(eq(queueConfigs.eventId, eventId)),
  ]);
  const out: { scope: TranslationScope; item: RawItem }[] = [];
  const add = (scope: TranslationScope, item: RawItem) => out.push({ scope, item });
  add('event', {
    entity: 'event',
    group: 'event',
    id: event.id,
    label: event.title,
    translations: event.translations,
    base: { title: event.title, subtitle: event.subtitle, description: event.description },
  });
  if (venue) {
    add('event', {
      entity: 'venue',
      group: 'venue',
      id: venue.id,
      label: venue.name,
      translations: venue.translations,
      base: { name: venue.name, description: venue.description },
    });
  }
  for (const c of categories) {
    add('pricing', {
      entity: 'priceCategory',
      group: 'categories',
      id: c.id,
      label: c.name,
      translations: c.translations,
      base: { name: c.name, description: c.description },
    });
  }
  for (const t of types) {
    add('pricing', {
      entity: 'ticketType',
      group: 'ticketTypes',
      id: t.id,
      label: t.name,
      translations: t.translations,
      base: { name: t.name, description: t.description },
    });
  }
  for (const f of feeRows) {
    add('fees', {
      entity: 'fee',
      group: f.eventId ? 'eventFees' : 'globalFees',
      id: f.id,
      label: f.name,
      translations: f.translations,
      base: { name: f.name },
    });
  }
  for (const box of event.infoBoxes) {
    add('shopPage', {
      entity: 'infoBox',
      group: 'infoBoxes',
      id: box.id,
      label: box.title || box.id.slice(0, 8),
      translations: box.translations ?? {},
      base: { title: box.title, content: box.content },
    });
  }
  for (const q of queue) {
    add('waitingRoom', {
      entity: 'queueConfig',
      group: 'queue',
      id: q.id,
      label: q.title ?? '',
      translations: q.translations,
      base: { title: q.title, message: q.message },
    });
  }
  return out;
}

export async function loadTranslationItems(
  ctx: CoreContext,
  eventId: string,
  scope: TranslationScope,
  locale: string,
): Promise<TranslationGroupView[]> {
  const groups = new Map<string, TranslationItemView[]>();
  for (const { scope: s, item } of await collectItems(ctx, eventId)) {
    if (s !== scope) continue;
    const defs = TRANSLATABLE_FIELDS[item.entity];
    const view: TranslationItemView = {
      entity: item.entity,
      id: item.id,
      label: item.label,
      fields: defs
        .filter((d) => item.base[d.name] !== undefined)
        .map((d) => ({
          name: d.name,
          rich: !!d.rich,
          max: d.max,
          base: item.base[d.name] ?? '',
          value: item.translations[locale]?.[d.name] ?? '',
        })),
    };
    const list = groups.get(item.group) ?? [];
    list.push(view);
    groups.set(item.group, list);
  }
  return [...groups].map(([key, items]) => ({
    key,
    items,
    ...(scope === 'fees' && key === 'globalFees' ? { readOnly: true } : {}),
  }));
}

/** "done / total" translated texts per non-default locale (all tabs + the seating plan). */
export async function eventTranslationCompleteness(
  ctx: CoreContext,
  eventId: string,
): Promise<Record<string, { done: number; total: number }>> {
  const { defaultLocale } = await getSetting(ctx, 'general');
  const items = (await collectItems(ctx, eventId)).map(({ item }) => item);
  const [event] = await ctx.db
    .select({ seatMapId: events.seatMapId })
    .from(events)
    .where(eq(events.id, eventId));
  if (event?.seatMapId) {
    const mapId = event.seatMapId;
    const [sections, elements, entrances] = await Promise.all([
      ctx.db
        .select()
        .from(seatMapSections)
        .where(and(eq(seatMapSections.seatMapId, mapId), isNull(seatMapSections.removedAt))),
      ctx.db.select().from(seatMapElements).where(eq(seatMapElements.seatMapId, mapId)),
      ctx.db.select().from(seatMapEntrances).where(eq(seatMapEntrances.seatMapId, mapId)),
    ]);
    for (const s of sections)
      items.push({
        entity: 'section',
        group: 'section',
        id: s.id,
        label: s.name,
        translations: s.translations,
        base: { name: s.name, ticketLabel: s.ticketLabel },
      });
    for (const e of elements)
      if (e.label)
        items.push({
          entity: 'element',
          group: 'element',
          id: e.id,
          label: e.label,
          translations: e.translations,
          base: { label: e.label },
        });
    for (const e of entrances)
      items.push({
        entity: 'entrance',
        group: 'entrance',
        id: e.id,
        label: e.name,
        translations: e.translations,
        base: { name: e.name },
      });
  }
  const result: Record<string, { done: number; total: number }> = {};
  for (const locale of translationLocales(defaultLocale)) {
    result[locale] = translationCompleteness(
      items.map((i) => ({ translations: i.translations, base: i.base })),
      locale,
    );
  }
  return result;
}

/**
 * Saves the texts of one locale. `sanitizeRich` is applied to rich-text fields (the same
 * sanitiser as for the base field). Unknown entities / rows of other events are rejected.
 */
export async function saveTranslations(
  ctx: CoreContext,
  params: {
    eventId: string;
    scope: TranslationScope;
    locale: string;
    updates: TranslationUpdate[];
    sanitizeRich: (html: string) => string;
  },
): Promise<void> {
  const { eventId, scope, locale, updates, sanitizeRich } = params;
  const { defaultLocale } = await getSetting(ctx, 'general');
  if (
    !(SUPPORTED_LOCALES as readonly string[]).includes(locale) ||
    locale === normalizeLocale(defaultLocale)
  ) {
    throw new DomainError('INVALID_LOCALE', 'Choose a translation language', 400);
  }
  const allowedEntities = new Set(SCOPE_ENTITIES[scope]);
  const clean = (entity: TranslatableEntity, fields: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const def of TRANSLATABLE_FIELDS[entity]) {
      const raw = fields[def.name];
      if (raw === undefined) continue;
      const value = def.rich ? sanitizeRich(raw) : raw.trim();
      if (value.length > def.max) {
        throw new DomainError('TRANSLATION_TOO_LONG', `${def.name} is too long`, 422, {
          field: def.name,
        });
      }
      out[def.name] = isBlankText(value) ? '' : value;
    }
    return out;
  };

  await withTransaction(ctx.db, async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for('update');
    if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
    let infoBoxes: EventInfoBox[] = event.infoBoxes;
    let infoBoxesChanged = false;

    for (const update of updates) {
      if (!allowedEntities.has(update.entity)) {
        throw new DomainError('INVALID_ENTITY', 'Not translatable here', 400);
      }
      const fields = clean(update.entity, update.fields);
      const merge = (existing: Translations) => mergeLocaleTranslations(existing, locale, fields);
      const notFound = () => new DomainError('NOT_FOUND', 'Entry not found', 404);
      switch (update.entity) {
        case 'event': {
          if (update.id !== eventId) throw notFound();
          await tx
            .update(events)
            .set({ translations: merge(event.translations) })
            .where(eq(events.id, eventId));
          break;
        }
        case 'venue': {
          if (update.id !== event.venueId) throw notFound();
          const [row] = await tx
            .select()
            .from(venues)
            .where(eq(venues.id, update.id))
            .for('update');
          if (!row) throw notFound();
          await tx
            .update(venues)
            .set({ translations: merge(row.translations) })
            .where(eq(venues.id, update.id));
          break;
        }
        case 'priceCategory': {
          const [row] = await tx
            .select()
            .from(priceCategories)
            .where(and(eq(priceCategories.id, update.id), eq(priceCategories.eventId, eventId)))
            .for('update');
          if (!row) throw notFound();
          await tx
            .update(priceCategories)
            .set({ translations: merge(row.translations) })
            .where(eq(priceCategories.id, update.id));
          break;
        }
        case 'ticketType': {
          const [row] = await tx
            .select()
            .from(ticketTypes)
            .where(and(eq(ticketTypes.id, update.id), eq(ticketTypes.eventId, eventId)))
            .for('update');
          if (!row) throw notFound();
          await tx
            .update(ticketTypes)
            .set({ translations: merge(row.translations) })
            .where(eq(ticketTypes.id, update.id));
          break;
        }
        case 'fee': {
          const [row] = await tx
            .select()
            .from(fees)
            .where(and(eq(fees.id, update.id), eq(fees.eventId, eventId)))
            .for('update');
          if (!row) throw notFound();
          await tx
            .update(fees)
            .set({ translations: merge(row.translations) })
            .where(eq(fees.id, update.id));
          break;
        }
        case 'queueConfig': {
          const [row] = await tx
            .select()
            .from(queueConfigs)
            .where(and(eq(queueConfigs.id, update.id), eq(queueConfigs.eventId, eventId)))
            .for('update');
          if (!row) throw notFound();
          await tx
            .update(queueConfigs)
            .set({ translations: merge(row.translations) })
            .where(eq(queueConfigs.id, update.id));
          break;
        }
        case 'infoBox': {
          if (!infoBoxes.some((b) => b.id === update.id)) throw notFound();
          infoBoxes = infoBoxes.map((b) =>
            b.id === update.id ? { ...b, translations: merge(b.translations ?? {}) } : b,
          );
          infoBoxesChanged = true;
          break;
        }
        default:
          throw new DomainError('INVALID_ENTITY', 'Not translatable here', 400);
      }
    }
    if (infoBoxesChanged) {
      await tx.update(events).set({ infoBoxes }).where(eq(events.id, eventId));
    }
  });

  // Category / tariff names are part of the cached public plan.
  if (scope === 'pricing') {
    const [event] = await ctx.db
      .select({ seatMapId: events.seatMapId })
      .from(events)
      .where(eq(events.id, eventId));
    if (event?.seatMapId) {
      await invalidatePublicSeatMap(ctx, eventId, await seatMapVersion(ctx, event.seatMapId));
    }
  }
}

// ─── Global (event independent) texts ───────────────────────────────────────

/** Global fees (`/admin/fees`) and the global waiting room config (`/admin/waiting-room`). */
export const GLOBAL_TRANSLATION_SCOPES = ['globalFees', 'globalQueue'] as const;
export type GlobalTranslationScope = (typeof GLOBAL_TRANSLATION_SCOPES)[number];

async function collectGlobalItems(ctx: CoreContext, scope: GlobalTranslationScope) {
  const items: RawItem[] = [];
  if (scope === 'globalFees') {
    for (const f of await ctx.db.select().from(fees).where(isNull(fees.eventId))) {
      items.push({
        entity: 'fee',
        group: 'globalFees',
        id: f.id,
        label: f.name,
        translations: f.translations,
        base: { name: f.name },
      });
    }
  } else {
    for (const q of await ctx.db.select().from(queueConfigs).where(isNull(queueConfigs.eventId))) {
      items.push({
        entity: 'queueConfig',
        group: 'queue',
        id: q.id,
        label: q.title ?? '',
        translations: q.translations,
        base: { title: q.title, message: q.message },
      });
    }
  }
  return items;
}

export async function loadGlobalTranslationItems(
  ctx: CoreContext,
  scope: GlobalTranslationScope,
  locale: string,
): Promise<TranslationGroupView[]> {
  const groups = new Map<string, TranslationItemView[]>();
  for (const item of await collectGlobalItems(ctx, scope)) {
    const view: TranslationItemView = {
      entity: item.entity,
      id: item.id,
      label: item.label,
      fields: TRANSLATABLE_FIELDS[item.entity].map((d) => ({
        name: d.name,
        rich: !!d.rich,
        max: d.max,
        base: item.base[d.name] ?? '',
        value: item.translations[locale]?.[d.name] ?? '',
      })),
    };
    groups.set(item.group, [...(groups.get(item.group) ?? []), view]);
  }
  return [...groups].map(([key, items]) => ({ key, items }));
}

export async function globalTranslationCompleteness(
  ctx: CoreContext,
  scope: GlobalTranslationScope,
): Promise<Record<string, { done: number; total: number }>> {
  const { defaultLocale } = await getSetting(ctx, 'general');
  const items = await collectGlobalItems(ctx, scope);
  return Object.fromEntries(
    translationLocales(defaultLocale).map((locale) => [
      locale,
      translationCompleteness(
        items.map((i) => ({ translations: i.translations, base: i.base })),
        locale,
      ),
    ]),
  );
}

export async function saveGlobalTranslations(
  ctx: CoreContext,
  params: {
    scope: GlobalTranslationScope;
    locale: string;
    updates: TranslationUpdate[];
    sanitizeRich: (html: string) => string;
  },
): Promise<void> {
  const { scope, locale, updates } = params;
  const { defaultLocale } = await getSetting(ctx, 'general');
  if (
    !(SUPPORTED_LOCALES as readonly string[]).includes(locale) ||
    locale === normalizeLocale(defaultLocale)
  ) {
    throw new DomainError('INVALID_LOCALE', 'Choose a translation language', 400);
  }
  const entity: TranslatableEntity = scope === 'globalFees' ? 'fee' : 'queueConfig';
  await withTransaction(ctx.db, async (tx) => {
    for (const update of updates) {
      if (update.entity !== entity) {
        throw new DomainError('INVALID_ENTITY', 'Not translatable here', 400);
      }
      const fields: Record<string, string> = {};
      for (const def of TRANSLATABLE_FIELDS[entity]) {
        const raw = update.fields[def.name];
        if (raw === undefined) continue;
        const value = def.rich ? params.sanitizeRich(raw) : raw.trim();
        if (value.length > def.max) {
          throw new DomainError('TRANSLATION_TOO_LONG', `${def.name} is too long`, 422);
        }
        fields[def.name] = value;
      }
      if (scope === 'globalFees') {
        const [row] = await tx
          .select()
          .from(fees)
          .where(and(eq(fees.id, update.id), isNull(fees.eventId)))
          .for('update');
        if (!row) throw new DomainError('NOT_FOUND', 'Entry not found', 404);
        await tx
          .update(fees)
          .set({ translations: mergeLocaleTranslations(row.translations, locale, fields) })
          .where(eq(fees.id, update.id));
      } else {
        const [row] = await tx
          .select()
          .from(queueConfigs)
          .where(and(eq(queueConfigs.id, update.id), isNull(queueConfigs.eventId)))
          .for('update');
        if (!row) throw new DomainError('NOT_FOUND', 'Entry not found', 404);
        await tx
          .update(queueConfigs)
          .set({ translations: mergeLocaleTranslations(row.translations, locale, fields) })
          .where(eq(queueConfigs.id, update.id));
      }
    }
  });
}
