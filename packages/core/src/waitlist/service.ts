import {
  events,
  orderItems,
  orders,
  priceCategories,
  waitlistEntries,
  waitlistRemovals,
  withTransaction,
} from '@tix/db';
import {
  INVENTORY_HOLDING_ITEM_STATUSES,
  normalizeLocale,
  type WaitlistCategoryState,
  type WaitlistTrigger,
} from '@tix/shared';
import { signToken, verifyToken } from '@tix/shared/server';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadCalendarEvents } from '../calendar/data';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email/request';
import { computeSaleState, type EventRow } from '../events';
import { formatDateTime } from '../format';
import { coreLog } from '../log';
import { buildCsv } from '../accounting/csv';
import { getSetting } from '../settings';
import {
  EMPTY_WAITLIST_AVAILABILITY,
  getWaitlistAvailability,
  getWaitlistCategoryStates,
  matchesAvailability,
  type WaitlistAvailability,
} from './availability';

/**
 * Waiting list of sold-out events. Flow: visitor joins (`joinWaitlist`) → confirmation e-mail
 * (double opt-in) → `confirmWaitlistEntry` → when tickets become available again the worker
 * (`evaluateWaitlist`) notifies everybody who matches, all at once (first come, first served; no
 * seats are reserved). An entry names a price category or "any category" (`category_id` NULL: a
 * wish that one category can serve); one address may hold several entries but gets at most one
 * e-mail per availability wave (the earliest matching entry wins). A notified entry is disarmed and re-armed once its wish cannot be served
 * any more (sold out again), so it is notified at most once per availability wave. Entries
 * disappear when the person bought (checked by e-mail address), after the event started, or on
 * request.
 */

/** `{{categoryName}}` of an entry without a category preference. */
const ANY_CATEGORY_LABEL = { en: 'Any category', de: 'Jede Kategorie' } as const;

const TOKEN_CONFIRM = 'waitlist-confirm';
const TOKEN_UNSUBSCRIBE = 'waitlist-unsub';
/** The unsubscribe link in notifications stays valid for a year. */
const UNSUBSCRIBE_TTL_SECONDS = 365 * 24 * 3600;

export const joinInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  firstName: z.string().trim().max(100).optional(),
  quantity: z.number().int().min(1),
  categoryId: z.uuid().nullable().optional(),
  locale: z.string().max(10).optional(),
});
export type JoinWaitlistInput = z.input<typeof joinInput>;

export type WaitlistEntryRow = typeof waitlistEntries.$inferSelect;

/** Waiting list switched on for this event (event override, else the global setting). */
export async function isWaitlistEnabled(
  ctx: Pick<CoreContext, 'db'>,
  event: Pick<EventRow, 'waitlistEnabled'>,
): Promise<boolean> {
  if (event.waitlistEnabled !== null) return event.waitlistEnabled;
  return (await getSetting(ctx, 'waitlist')).enabled;
}

/** Trigger of the banner: event override, else the global setting. */
export async function effectiveWaitlistTrigger(
  ctx: Pick<CoreContext, 'db'>,
  event: Pick<EventRow, 'waitlistTrigger'>,
): Promise<WaitlistTrigger> {
  if (event.waitlistTrigger) return event.waitlistTrigger;
  return (await getSetting(ctx, 'waitlist')).trigger;
}

export interface WaitlistOffer {
  trigger: WaitlistTrigger;
  maxTickets: number;
  /**
   * Every price category that has tickets at all, with its counts at render time. The browser
   * keeps them current from the live seat deltas and decides with `decideWaitlistOffer`
   * whether the banner shows (the same shared function as the server uses here).
   */
  categories: (WaitlistCategoryState & { name: string })[];
}

/**
 * What the event page needs for the waiting-list block: null while the waiting list is off or the
 * sale is not running. Whether the banner is visible is decided from the counts (see
 * `decideWaitlistOffer`) – the block is always rendered so it can appear when tickets run out.
 */
export async function getWaitlistOffer(
  ctx: CoreContext,
  event: EventRow,
  categoryNames: ReadonlyMap<string, string>,
): Promise<WaitlistOffer | null> {
  if (event.status !== 'PUBLISHED' && event.status !== 'POSTPONED') return null;
  if (computeSaleState(event) !== 'ON_SALE' || !event.seatMapId) return null;
  if (!(await isWaitlistEnabled(ctx, event))) return null;
  const [states, trigger, settings] = await Promise.all([
    getWaitlistCategoryStates(ctx, event),
    effectiveWaitlistTrigger(ctx, event),
    getSetting(ctx, 'waitlist'),
  ]);
  return {
    trigger,
    maxTickets: settings.maxTicketsPerEntry,
    categories: states
      .filter((s) => s.capacity > 0)
      .map((s) => ({ ...s, name: categoryNames.get(s.id) ?? '' }))
      .filter((c) => c.name),
  };
}

function confirmToken(ctx: Pick<CoreContext, 'sessionSecret'>, entryId: string, ttlHours: number) {
  return signToken(TOKEN_CONFIRM, { eid: entryId }, ttlHours * 3600, ctx.sessionSecret);
}

/** Link that removes an entry (in notification e-mails). */
export function waitlistUnsubscribeToken(
  ctx: Pick<CoreContext, 'sessionSecret'>,
  entryId: string,
): string {
  return signToken(TOKEN_UNSUBSCRIBE, { eid: entryId }, UNSUBSCRIBE_TTL_SECONDS, ctx.sessionSecret);
}

interface WaitlistMailContext {
  title: string;
  date: string;
  venue: string;
  eventUrl: string | null;
  categoryName: string | null;
}

async function mailContext(
  ctx: CoreContext,
  entry: WaitlistEntryRow,
): Promise<WaitlistMailContext | null> {
  const [detail] = await loadCalendarEvents(ctx, [entry.eventId], entry.locale);
  if (!detail) return null;
  let categoryName: string | null = null;
  if (entry.categoryId) {
    const [cat] = await ctx.db
      .select({ name: priceCategories.name })
      .from(priceCategories)
      .where(eq(priceCategories.id, entry.categoryId));
    categoryName = cat?.name ?? null;
  }
  return {
    title: detail.title,
    date: formatDateTime(detail.startsAt, entry.locale, detail.timeZone),
    venue: detail.location ?? '',
    eventUrl: detail.url,
    categoryName,
  };
}

/**
 * Queues one waiting-list e-mail (call inside the transaction that changes the entry; dispatch
 * the returned id after the commit).
 */
async function queueMail(
  ctx: CoreContext,
  tx: Parameters<typeof createEmailMessage>[1],
  key: 'WAITLIST_CONFIRM' | 'WAITLIST_AVAILABLE' | 'WAITLIST_REMOVED',
  entry: WaitlistEntryRow,
  mail: WaitlistMailContext,
  extra: Record<string, string | null> = {},
): Promise<string> {
  return createEmailMessage(ctx, tx, {
    key,
    to: entry.email,
    locale: entry.locale,
    eventId: entry.eventId,
    variables: {
      firstName: entry.firstName,
      eventTitle: mail.title,
      eventDate: mail.date,
      eventVenue: mail.venue,
      eventUrl: mail.eventUrl,
      categoryName: mail.categoryName ?? ANY_CATEGORY_LABEL[entry.locale === 'de' ? 'de' : 'en'],
      quantity: entry.quantity,
      ...extra,
    },
  });
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export type JoinResult = { status: 'CONFIRMATION_SENT' };

/**
 * Adds an entry (or refreshes the confirmation of an unconfirmed one) and sends the opt-in
 * e-mail. The answer never reveals whether an address is already confirmed on the list: a confirmed
 * entry gets the same answer, just no second e-mail.
 */
export async function joinWaitlist(
  ctx: CoreContext,
  event: EventRow,
  rawInput: JoinWaitlistInput,
): Promise<JoinResult> {
  const input = joinInput.parse(rawInput);
  const settings = await getSetting(ctx, 'waitlist');
  if (!(await isWaitlistEnabled(ctx, event)) || event.startsAt.getTime() <= Date.now()) {
    throw new DomainError('WAITLIST_UNAVAILABLE', 'The waiting list is not available', 409);
  }
  if (input.quantity > settings.maxTicketsPerEntry) {
    throw new DomainError('WAITLIST_QUANTITY', 'Too many tickets requested', 422);
  }
  if (input.categoryId) {
    const [cat] = await ctx.db
      .select({ id: priceCategories.id })
      .from(priceCategories)
      .where(and(eq(priceCategories.id, input.categoryId), eq(priceCategories.eventId, event.id)));
    if (!cat) throw new DomainError('CATEGORY_NOT_FOUND', 'Category not found', 404);
  }
  const locale = normalizeLocale(input.locale ?? (await getSetting(ctx, 'general')).defaultLocale);

  const outcome = await withTransaction(ctx.db, async (tx) => {
    const [existing] = await tx
      .select()
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.eventId, event.id),
          sql`lower(${waitlistEntries.email}) = ${input.email}`,
          input.categoryId
            ? eq(waitlistEntries.categoryId, input.categoryId)
            : isNull(waitlistEntries.categoryId),
        ),
      )
      .for('update');
    if (existing?.confirmedAt) return null;
    if (!existing) {
      const [counted] = await tx
        .select({ n: count() })
        .from(waitlistEntries)
        .where(eq(waitlistEntries.eventId, event.id));
      if ((counted?.n ?? 0) >= settings.maxEntriesPerEvent) {
        throw new DomainError('WAITLIST_FULL', 'The waiting list is full', 409);
      }
    }
    const values = {
      firstName: input.firstName || null,
      quantity: input.quantity,
      locale,
      confirmationSentAt: new Date(),
    };
    const [entry] = existing
      ? await tx
          .update(waitlistEntries)
          .set(values)
          .where(eq(waitlistEntries.id, existing.id))
          .returning()
      : await tx
          .insert(waitlistEntries)
          .values({
            eventId: event.id,
            email: input.email,
            categoryId: input.categoryId ?? null,
            ...values,
          })
          .returning();
    const mail = await mailContext(ctx, entry!);
    if (!mail) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
    const expires = new Date(Date.now() + settings.confirmationTtlHours * 3_600_000);
    const detailZone = (await loadCalendarEvents(ctx, [event.id], locale))[0]!.timeZone;
    const messageId = await queueMail(ctx, tx, 'WAITLIST_CONFIRM', entry!, mail, {
      confirmUrl: `${ctx.appUrl ?? ''}/${locale}/waitlist/confirm?token=${encodeURIComponent(
        confirmToken(ctx, entry!.id, settings.confirmationTtlHours),
      )}`,
      expiresAt: formatDateTime(expires, locale, detailZone, 'long'),
    });
    return messageId;
  }).catch((err: unknown) => {
    // Two identical joins at the same time: the other one created the entry and sends the mail.
    if (isUniqueViolation(err)) return null;
    throw err;
  });
  if (outcome === null) return { status: 'CONFIRMATION_SENT' };
  await dispatchEmailMessage(ctx, outcome);
  return { status: 'CONFIRMATION_SENT' };
}

/** Whether the wish of an entry can be served by the tickets available right now. */
async function servableNow(ctx: CoreContext, entry: WaitlistEntryRow): Promise<boolean> {
  const [event] = await ctx.db.select().from(events).where(eq(events.id, entry.eventId));
  if (
    !event ||
    event.startsAt.getTime() <= Date.now() ||
    (event.status !== 'PUBLISHED' && event.status !== 'POSTPONED') ||
    computeSaleState(event) !== 'ON_SALE' ||
    !event.seatMapId
  )
    return false;
  return matchesAvailability(entry, await getWaitlistAvailability(ctx, event));
}

let servableCheckLogged = false;

/** Confirms an entry from the opt-in link. Opening the link twice is harmless. */
export async function confirmWaitlistEntry(
  ctx: CoreContext,
  token: string,
): Promise<{
  eventId: string;
  alreadyConfirmed: boolean;
  availableNow: boolean;
  eventSlug: string | null;
}> {
  const claims = verifyToken<{ eid: string }>(token, TOKEN_CONFIRM, ctx.sessionSecret);
  if (!claims || typeof claims.eid !== 'string') {
    throw new DomainError('TOKEN_INVALID', 'The link is invalid or expired', 400);
  }
  const [row] = await ctx.db
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, claims.eid));
  if (!row) throw new DomainError('TOKEN_INVALID', 'The link is invalid or expired', 400);
  if (row.confirmedAt) {
    return { eventId: row.eventId, alreadyConfirmed: true, availableNow: false, eventSlug: null };
  }
  // An "any category" entry that is already servable when it is confirmed has nothing to wait for
  // (some category has tickets right now): it starts disarmed and fires at the next wave, i.e.
  // after the event was out of tickets again.
  // The check reads live inventory: when that fails the link still works (armed, the safe default).
  let servable = false;
  try {
    servable = await servableNow(ctx, row);
  } catch (err) {
    if (!servableCheckLogged) {
      servableCheckLogged = true;
      coreLog.error(
        { err },
        'waitlist: availability check failed while confirming, entry is armed',
      );
    }
  }
  const armed = row.categoryId !== null || !servable;
  await ctx.db
    .update(waitlistEntries)
    .set({ confirmedAt: new Date(), armed })
    .where(and(eq(waitlistEntries.id, row.id), isNull(waitlistEntries.confirmedAt)));
  const [ev] = servable
    ? await ctx.db.select({ slug: events.slug }).from(events).where(eq(events.id, row.eventId))
    : [];
  return {
    eventId: row.eventId,
    alreadyConfirmed: false,
    availableNow: servable,
    eventSlug: ev?.slug ?? null,
  };
}

/** Deletes an entry and records its id in the retained ledger (restores re-apply the removal). */
async function deleteEntries(
  tx: Pick<CoreContext['db'], 'delete' | 'insert'>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .insert(waitlistRemovals)
    .values(ids.map((entryId) => ({ entryId })))
    .onConflictDoNothing();
  await tx.delete(waitlistEntries).where(inArray(waitlistEntries.id, ids));
}

/** Removes an entry via the unsubscribe link. Idempotent. */
export async function unsubscribeWaitlistEntry(ctx: CoreContext, token: string): Promise<void> {
  const claims = verifyToken<{ eid: string }>(token, TOKEN_UNSUBSCRIBE, ctx.sessionSecret);
  if (!claims || typeof claims.eid !== 'string') {
    throw new DomainError('TOKEN_INVALID', 'The link is invalid or expired', 400);
  }
  await withTransaction(ctx.db, (tx) => deleteEntries(tx, [claims.eid]));
}

// ─── Evaluation (worker) ────────────────────────────────────────────────────

export interface WaitlistEvaluation {
  events: number;
  notified: number;
  removedBought: number;
  rearmed: number;
  expiredUnconfirmed: number;
}

/** Addresses with an active order for the event (they bought: no need to notify them). */
async function buyerEmails(
  ctx: CoreContext,
  eventId: string,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await ctx.db
    .selectDistinct({ email: orders.email })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orderItems.eventId, eventId),
        inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
        eq(orders.isTest, false),
        inArray(sql`lower(${orders.email})`, emails),
      ),
    );
  return new Set(rows.map((r) => (r.email ?? '').toLowerCase()));
}

/**
 * Checks one event and notifies the entries whose wish can be served. `force` (admin "notify
 * now") ignores the pause between two notifications and the armed flag.
 */
export async function evaluateWaitlistEvent(
  ctx: CoreContext,
  event: EventRow,
  options: { force?: boolean } = {},
): Promise<Pick<WaitlistEvaluation, 'notified' | 'removedBought' | 'rearmed'>> {
  const result = { notified: 0, removedBought: 0, rearmed: 0 };
  if (event.startsAt.getTime() <= Date.now() || event.status === 'CANCELLED') return result;
  const entries = await ctx.db
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.eventId, event.id), isNotNull(waitlistEntries.confirmedAt)))
    .orderBy(asc(waitlistEntries.createdAt));
  if (entries.length === 0) return result;

  const sellable =
    (event.status === 'PUBLISHED' || event.status === 'POSTPONED') &&
    computeSaleState(event) === 'ON_SALE';
  const availability: WaitlistAvailability = sellable
    ? await getWaitlistAvailability(ctx, event)
    : EMPTY_WAITLIST_AVAILABILITY;
  const settings = await getSetting(ctx, 'waitlist');
  const pauseMs = settings.renotifyAfterHours * 3_600_000;

  // Re-arm entries whose wish is not servable (a new wave starts when it becomes servable again).
  const matching = entries.filter((e) => matchesAvailability(e, availability));
  const rearm = entries.filter((e) => !e.armed && !matchesAvailability(e, availability));
  if (rearm.length > 0) {
    await ctx.db
      .update(waitlistEntries)
      .set({ armed: true })
      .where(
        inArray(
          waitlistEntries.id,
          rearm.map((e) => e.id),
        ),
      );
    result.rearmed = rearm.length;
  }
  if (!sellable || matching.length === 0) return result;

  const buyers = await buyerEmails(
    ctx,
    event.id,
    matching.map((e) => e.email.toLowerCase()),
  );
  const mails: string[] = [];
  /** Addresses notified by THIS run only (an earlier run's mails are covered by `lastNotifiedAt`). */
  const mailed = new Set<string>();
  for (const entry of matching) {
    const address = entry.email.toLowerCase();
    if (buyers.has(address)) {
      await withTransaction(ctx.db, (tx) => deleteEntries(tx, [entry.id]));
      result.removedBought += 1;
      continue;
    }
    if (mailed.has(address)) {
      // Second entry of an address that was just notified (e.g. a category and "any"): one mail per
      // wave and address – the earlier entry wins, this one is disarmed until the next wave.
      if (entry.armed || options.force)
        await ctx.db
          .update(waitlistEntries)
          .set({ armed: false })
          .where(eq(waitlistEntries.id, entry.id));
      continue;
    }
    if (!options.force) {
      if (!entry.armed) continue;
      if (entry.lastNotifiedAt && Date.now() - entry.lastNotifiedAt.getTime() < pauseMs) continue;
    }
    const mail = await mailContext(ctx, entry);
    if (!mail) continue;
    const messageId = await withTransaction(ctx.db, async (tx) => {
      // The conditional update claims the entry: a concurrent run cannot notify it twice.
      const claimed = await tx
        .update(waitlistEntries)
        .set({
          armed: false,
          lastNotifiedAt: new Date(),
          notifiedCount: sql`${waitlistEntries.notifiedCount} + 1`,
        })
        .where(
          and(
            eq(waitlistEntries.id, entry.id),
            options.force ? undefined : eq(waitlistEntries.armed, true),
            entry.lastNotifiedAt
              ? eq(waitlistEntries.lastNotifiedAt, entry.lastNotifiedAt)
              : isNull(waitlistEntries.lastNotifiedAt),
          ),
        )
        .returning({ id: waitlistEntries.id });
      if (claimed.length === 0) return null;
      return queueMail(ctx, tx, 'WAITLIST_AVAILABLE', entry, mail, {
        unsubscribeUrl: `${ctx.appUrl ?? ''}/${entry.locale}/waitlist/unsubscribe?token=${encodeURIComponent(
          waitlistUnsubscribeToken(ctx, entry.id),
        )}`,
      });
    });
    if (messageId) {
      mailed.add(address);
      mails.push(messageId);
      result.notified += 1;
    }
  }
  for (const id of mails) await dispatchEmailMessage(ctx, id);
  return result;
}

/**
 * Worker run: for every event with confirmed entries (at most one check per event and
 * `evaluateIntervalMinutes`, across all workers) – plus deletion of unconfirmed entries whose
 * confirmation link expired.
 */
export async function evaluateWaitlist(ctx: CoreContext): Promise<WaitlistEvaluation> {
  const settings = await getSetting(ctx, 'waitlist');
  const total: WaitlistEvaluation = {
    events: 0,
    notified: 0,
    removedBought: 0,
    rearmed: 0,
    expiredUnconfirmed: 0,
  };
  const expired = await ctx.db
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .where(
      and(
        isNull(waitlistEntries.confirmedAt),
        lt(
          waitlistEntries.createdAt,
          new Date(Date.now() - settings.confirmationTtlHours * 3_600_000),
        ),
      ),
    );
  if (expired.length > 0) {
    await ctx.db.delete(waitlistEntries).where(
      inArray(
        waitlistEntries.id,
        expired.map((e) => e.id),
      ),
    );
    total.expiredUnconfirmed = expired.length;
  }
  const rows = await ctx.db
    .selectDistinct({ eventId: waitlistEntries.eventId })
    .from(waitlistEntries)
    .innerJoin(events, eq(events.id, waitlistEntries.eventId))
    .where(and(isNotNull(waitlistEntries.confirmedAt), gt(events.startsAt, new Date())));
  for (const { eventId } of rows) {
    // Debounce: one evaluation per event and interval, whichever worker gets there first.
    const claimed = await ctx.redis.set(
      ctx.keys.mutex(`waitlist-eval:${eventId}`),
      '1',
      'PX',
      Math.max(1, settings.evaluateIntervalMinutes) * 60_000 - 5_000,
      'NX',
    );
    if (claimed !== 'OK') continue;
    try {
      const [event] = await ctx.db.select().from(events).where(eq(events.id, eventId));
      if (!event || !(await isWaitlistEnabled(ctx, event))) continue;
      const r = await evaluateWaitlistEvent(ctx, event);
      total.events += 1;
      total.notified += r.notified;
      total.removedBought += r.removedBought;
      total.rearmed += r.rearmed;
    } catch (err) {
      coreLog.error({ err, eventId }, '[waitlist] evaluation failed');
    }
  }
  return total;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export interface WaitlistAdminRow {
  id: string;
  email: string;
  firstName: string | null;
  quantity: number;
  categoryName: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  lastNotifiedAt: Date | null;
  notifiedCount: number;
}

export async function listWaitlistEntries(
  ctx: Pick<CoreContext, 'db'>,
  eventId: string,
): Promise<WaitlistAdminRow[]> {
  return ctx.db
    .select({
      id: waitlistEntries.id,
      email: waitlistEntries.email,
      firstName: waitlistEntries.firstName,
      quantity: waitlistEntries.quantity,
      categoryName: priceCategories.name,
      confirmedAt: waitlistEntries.confirmedAt,
      createdAt: waitlistEntries.createdAt,
      lastNotifiedAt: waitlistEntries.lastNotifiedAt,
      notifiedCount: waitlistEntries.notifiedCount,
    })
    .from(waitlistEntries)
    .leftJoin(priceCategories, eq(priceCategories.id, waitlistEntries.categoryId))
    .where(eq(waitlistEntries.eventId, eventId))
    .orderBy(asc(waitlistEntries.createdAt))
    .limit(20_000);
}

/** Admin removal; `notify` sends the "removed" e-mail to confirmed entries. */
export async function removeWaitlistEntries(
  ctx: CoreContext,
  eventId: string,
  ids: string[],
  options: { notify?: boolean } = {},
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await ctx.db
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.eventId, eventId), inArray(waitlistEntries.id, ids)));
  const messageIds: string[] = [];
  await withTransaction(ctx.db, async (tx) => {
    for (const row of rows) {
      if (options.notify && row.confirmedAt) {
        const mail = await mailContext(ctx, row);
        if (mail) messageIds.push(await queueMail(ctx, tx, 'WAITLIST_REMOVED', row, mail));
      }
    }
    await deleteEntries(
      tx,
      rows.map((r) => r.id),
    );
  });
  for (const id of messageIds) await dispatchEmailMessage(ctx, id);
  return rows.length;
}

/** Deletes entries of an e-mail address (GDPR erasure); returns the number removed. */
export async function eraseWaitlistForEmails(
  tx: Pick<CoreContext['db'], 'select' | 'delete' | 'insert'>,
  emails: string[],
): Promise<number> {
  if (emails.length === 0) return 0;
  const rows = await tx
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .where(inArray(sql`lower(${waitlistEntries.email})`, emails));
  await deleteEntries(
    tx,
    rows.map((r) => r.id),
  );
  return rows.length;
}

/** Retention: entries of events that have started (and unconfirmed leftovers) are deleted. */
export async function purgeWaitlist(ctx: Pick<CoreContext, 'db'>): Promise<number> {
  const rows = await ctx.db
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .innerJoin(events, eq(events.id, waitlistEntries.eventId))
    .where(or(lt(events.startsAt, new Date())));
  if (rows.length === 0) return 0;
  await ctx.db.delete(waitlistEntries).where(
    inArray(
      waitlistEntries.id,
      rows.map((r) => r.id),
    ),
  );
  return rows.length;
}

/** After a restore: removes entries that were deleted on request before the backup was restored. */
export async function replayWaitlistRemovals(ctx: Pick<CoreContext, 'db'>): Promise<number> {
  const removed = await ctx.db.select({ id: waitlistRemovals.entryId }).from(waitlistRemovals);
  if (removed.length === 0) return 0;
  const gone = await ctx.db
    .delete(waitlistEntries)
    .where(
      inArray(
        waitlistEntries.id,
        removed.map((r) => r.id),
      ),
    )
    .returning({ id: waitlistEntries.id });
  return gone.length;
}

/** CSV of the waiting list (Excel: BOM, `;`, formula-injection safe). */
export function buildWaitlistCsv(rows: WaitlistAdminRow[]): string {
  return buildCsv(
    [
      'email',
      'first_name',
      'tickets',
      'category',
      'confirmed_at',
      'signed_up_at',
      'last_notified_at',
      'notifications',
    ],
    rows.map((r) => [
      r.email,
      r.firstName,
      r.quantity,
      r.categoryName ?? 'any',
      r.confirmedAt?.toISOString() ?? null,
      r.createdAt.toISOString(),
      r.lastNotifiedAt?.toISOString() ?? null,
      r.notifiedCount,
    ]),
  );
}
