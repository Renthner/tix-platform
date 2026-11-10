import type { Translations } from '@tix/shared';
import { randomUUID } from 'node:crypto';
import {
  emailTemplates,
  events,
  fees,
  priceCategories,
  priceCategoryTicketTypes,
  queueConfigs,
  ticketTemplates,
  ticketTypes,
  walletPassDesigns,
  withTransaction,
  type Transaction,
} from '@tix/db';
import { eq } from 'drizzle-orm';
import { DomainError, type CoreContext } from './context';
import { ensureEventSigningKeyTx } from './tickets/keys';
import { wallClockShifter } from './zoned-time';
import { cloneSeatMap } from './seatmaps/clone';

export interface DuplicateEventInput {
  sourceEventId: string;
  userId: string;
  title: string;
  /** Shop URL slug; derived from the title when omitted. A derived slug gets a numeric suffix on collision. */
  slug?: string | null;
  startsAt: Date;
  /** Optional explicit values; when omitted they are the source's value shifted by the start offset. */
  doorsOpenAt?: Date | null;
  endsAt?: Date | null;
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TRANSLITERATION: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
};

function deriveSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLITERATION[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return slug || 'event';
}

async function slugExists(tx: Transaction, slug: string): Promise<boolean> {
  const [row] = await tx.select({ id: events.id }).from(events).where(eq(events.slug, slug));
  return !!row;
}

/** Translations without one field (of every locale). */
function withoutField(translations: Translations, field: string): Translations {
  const out: Translations = {};
  for (const [locale, fields] of Object.entries(translations)) {
    const { [field]: _removed, ...rest } = fields ?? {};
    if (Object.keys(rest).length) out[locale] = rest;
  }
  return out;
}

/**
 * Duplicates an event's configuration into a new DRAFT event (one transaction).
 *
 * Copied: all configuration columns, the event's own seat map (incl. edits and seat blocks),
 * price categories, tariffs (all content translations travel along; the title's are dropped), pricing matrix, event fees, waiting-room config, event ticket
 * templates, wallet design, event e-mail template overrides. Absolute dates are shifted by
 * (new start − old start). Media assets are shared by reference.
 *
 * Not copied: orders, tickets, check-in data, access codes (+ redemptions), announcements,
 * scanner assignments, Redis state. The signing key is freshly generated (when the process
 * can encrypt secrets; otherwise lazily on first ticket issue).
 */
export async function duplicateEvent(
  ctx: CoreContext,
  input: DuplicateEventInput,
): Promise<{ eventId: string; slug: string }> {
  const title = input.title.trim();
  if (!title) throw new DomainError('INVALID_TITLE', 'A title is required', 400);
  const explicitSlug = input.slug?.trim() || null;
  if (explicitSlug && (explicitSlug.length > 80 || !SLUG_PATTERN.test(explicitSlug))) {
    throw new DomainError('INVALID_SLUG', 'Invalid slug', 400);
  }

  return withTransaction(ctx.db, async (tx) => {
    const [source] = await tx.select().from(events).where(eq(events.id, input.sourceEventId));
    if (!source) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);

    // Slug: explicit → must be free; derived → numeric suffix on collision.
    let slug = explicitSlug ?? deriveSlug(title);
    if (explicitSlug) {
      if (await slugExists(tx, slug)) throw new DomainError('SLUG_TAKEN', 'Slug taken', 409);
    } else {
      const base = slug;
      for (let n = 2; await slugExists(tx, slug); n += 1) {
        slug = `${base.slice(0, 76)}-${n}`;
      }
    }

    const shift = wallClockShifter(source.startsAt, input.startsAt, source.timeZone);
    const doorsOpenAt =
      input.doorsOpenAt !== undefined ? input.doorsOpenAt : shift(source.doorsOpenAt);
    const endsAt = input.endsAt !== undefined ? input.endsAt : shift(source.endsAt);
    if (endsAt && endsAt <= input.startsAt) {
      throw new DomainError('INVALID_DATES', 'End must be after start', 400);
    }
    if (doorsOpenAt && doorsOpenAt > input.startsAt) {
      throw new DomainError('INVALID_DATES', 'Doors must open before start', 400);
    }

    // ── Price categories, tariffs, matrix ────────────────────────────────
    const categoryMap = new Map<string, string>();
    const typeMap = new Map<string, string>();
    const templateMap = new Map<string, string>();

    const sourceTemplates = await tx
      .select()
      .from(ticketTemplates)
      .where(eq(ticketTemplates.eventId, source.id));
    for (const row of sourceTemplates) templateMap.set(row.id, randomUUID());
    const mapTemplate = (id: string | null) => (id ? (templateMap.get(id) ?? id) : null);

    const sourceCategories = await tx
      .select()
      .from(priceCategories)
      .where(eq(priceCategories.eventId, source.id));
    for (const row of sourceCategories) categoryMap.set(row.id, randomUUID());
    const sourceTypes = await tx
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, source.id));
    for (const row of sourceTypes) typeMap.set(row.id, randomUUID());

    // ── Event row (ticket templates first need the event id: FK is on templates → events) ──
    const newEventId = randomUUID();
    const { id: _id, createdAt: _c, updatedAt: _u, ...config } = source;

    await tx.insert(events).values({
      ...config,
      id: newEventId,
      // Set after the copy below: its category references need the categories to exist first.
      seatMapId: null,
      slug,
      title,
      // The title is new: its translations belong to the old one and are dropped.
      translations:
        title === source.title ? source.translations : withoutField(source.translations, 'title'),
      status: 'DRAFT',
      shopSortOrder: null,
      startsAt: input.startsAt,
      doorsOpenAt,
      endsAt,
      presaleStartsAt: shift(source.presaleStartsAt),
      publicSaleStartsAt: shift(source.publicSaleStartsAt),
      saleEndsAt: shift(source.saleEndsAt),
      salesPaused: false,
      // Event-scoped template is re-pointed below once the copies exist.
      ticketTemplateId:
        source.ticketTemplateId && templateMap.has(source.ticketTemplateId)
          ? null
          : source.ticketTemplateId,
      googleWalletClassId: null,
      publishedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      clonedFromId: source.id,
      createdByUserId: input.userId,
    });

    if (sourceTemplates.length > 0) {
      await tx.insert(ticketTemplates).values(
        sourceTemplates.map(({ createdAt: _a, updatedAt: _b, ...row }) => ({
          ...row,
          id: templateMap.get(row.id)!,
          eventId: newEventId,
          createdByUserId: input.userId,
        })),
      );
      if (source.ticketTemplateId && templateMap.has(source.ticketTemplateId)) {
        await tx
          .update(events)
          .set({ ticketTemplateId: templateMap.get(source.ticketTemplateId)! })
          .where(eq(events.id, newEventId));
      }
    }

    if (sourceCategories.length > 0) {
      await tx.insert(priceCategories).values(
        sourceCategories.map(({ createdAt: _a, updatedAt: _b, ...row }) => ({
          ...row,
          id: categoryMap.get(row.id)!,
          eventId: newEventId,
          ticketTemplateId: mapTemplate(row.ticketTemplateId),
        })),
      );
    }
    if (sourceTypes.length > 0) {
      await tx.insert(ticketTypes).values(
        sourceTypes.map(({ createdAt: _a, updatedAt: _b, ...row }) => ({
          ...row,
          id: typeMap.get(row.id)!,
          eventId: newEventId,
        })),
      );
    }
    if (sourceCategories.length > 0) {
      const sourceMatrix = (
        await Promise.all(
          sourceCategories.map((c) =>
            tx
              .select()
              .from(priceCategoryTicketTypes)
              .where(eq(priceCategoryTicketTypes.priceCategoryId, c.id)),
          ),
        )
      ).flat();
      if (sourceMatrix.length > 0) {
        await tx.insert(priceCategoryTicketTypes).values(
          sourceMatrix.map(({ createdAt: _a, ...row }) => ({
            ...row,
            priceCategoryId: categoryMap.get(row.priceCategoryId)!,
            ticketTypeId: typeMap.get(row.ticketTypeId)!,
          })),
        );
      }
    }

    // Seat map copy (event-specific edits included; soft-removed entities skipped).
    if (source.seatMapId) {
      const seatMapId = await cloneSeatMap(tx, source.seatMapId, {
        kind: 'EVENT',
        name: title.slice(0, 120),
        categoryMap,
      });
      await tx.update(events).set({ seatMapId }).where(eq(events.id, newEventId));
    }

    // ── Fees (event adjustments / additional fees; globals stay shared) ──
    const sourceFees = await tx.select().from(fees).where(eq(fees.eventId, source.id));
    if (sourceFees.length > 0) {
      await tx.insert(fees).values(
        sourceFees.map(({ createdAt: _a, updatedAt: _b, ...row }) => ({
          ...row,
          id: randomUUID(),
          eventId: newEventId,
        })),
      );
    }

    // ── Waiting room, wallet design, e-mail overrides ───────────────────
    const [queue] = await tx.select().from(queueConfigs).where(eq(queueConfigs.eventId, source.id));
    if (queue) {
      const { createdAt: _a, updatedAt: _b, ...row } = queue;
      await tx
        .insert(queueConfigs)
        .values({ ...row, id: randomUUID(), eventId: newEventId, updatedByUserId: input.userId });
    }
    const [wallet] = await tx
      .select()
      .from(walletPassDesigns)
      .where(eq(walletPassDesigns.eventId, source.id));
    if (wallet) {
      const { createdAt: _a, updatedAt: _b, ...row } = wallet;
      await tx.insert(walletPassDesigns).values({ ...row, id: randomUUID(), eventId: newEventId });
    }
    const mails = await tx
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.eventId, source.id));
    if (mails.length > 0) {
      await tx.insert(emailTemplates).values(
        mails.map(({ createdAt: _a, updatedAt: _b, ...row }) => ({
          ...row,
          id: randomUUID(),
          eventId: newEventId,
          updatedByUserId: input.userId,
        })),
      );
    }

    // ── Fresh Ed25519 signing key (never copied) ────────────────────────
    if (ctx.secrets) await ensureEventSigningKeyTx(ctx, tx, newEventId);

    return { eventId: newEventId, slug };
  });
}
