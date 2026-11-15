import {
  customers,
  events,
  orderHistory,
  orderItems,
  orders,
  ticketChanges,
  tickets,
  withTransaction,
  type Executor,
  type Transaction,
} from '@tix/db';
import type { TicketChangeActor, TicketSelfServiceSettings } from '@tix/shared';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { formatDateTime } from '../format';
import { mailTranslator } from '../i18n/mail-messages';
import { coreLog } from '../log';
import { getSetting } from '../settings';
import { loadWalletTicketData, walletPlaceLabel } from '../wallet/data';
import { deactivateGoogleWalletObjects, ensureGoogleSaveUrl } from '../wallet/google';
import { walletAvailability } from '../wallet/links';
import { holderTicketToken, holderTicketUrls, verifyHolderTicketToken } from './holder';
import {
  dispatchMessages,
  holderRef,
  holderTicketVariables,
  queueHolderCancelledMail,
} from './holder-mail';
import { lockOrderTickets, reissueTicketInTransaction, type TicketRow } from './issue';
import { placeOrderBy } from './order';

/**
 * Customer self-service for issued tickets (docs/TICKETS.md "Self-service"):
 *  - change the attendee name of a ticket (QR code and ticket id stay, the name is not signed),
 *  - transfer a ticket to someone else (void + re-issue: new ticket id / QR / code, bound to the
 *    recipient's e-mail; the buyer's order, invoice and payments stay untouched).
 * Once a ticket has been transferred only its current holder may pass it on (not rename it); the
 * buyer cannot touch it any more. Admins can always intervene, including handing it back to the
 * buyer. Admin actions are exempt from the policy (deadline, switches, limits) and the caps.
 */

/**
 * Hard ceilings against using transfers as an e-mail relay. They hold whatever the settings say
 * (also "unlimited") and only apply to customers, never to admins.
 */
export const TRANSFER_CAPS = {
  /** Transfers of one seat (by customers), ever. */
  perTicket: 10,
  /** Transfers per order within 24 hours. */
  perOrderPerDay: 20,
  /** Transfers to one recipient address within 24 hours, across all orders. */
  perRecipientPerDay: 5,
} as const;
const DAY_MS = 24 * 3_600_000;

// ── Policy ────────────────────────────────────────────────────────────────────

export type SelfServiceBlock =
  | 'DISABLED'
  | 'NAME_CHANGE_DISABLED'
  | 'TRANSFER_DISABLED'
  | 'DEADLINE_PASSED'
  | 'LIMIT_REACHED'
  | 'CHECKED_IN'
  | 'ORDER_NOT_PAID'
  | 'HOLDER_TICKET'
  | 'NOT_VALID';

export interface EventSelfServiceOverride {
  selfServiceEnabled: boolean | null;
  selfServiceAllowNameChange: boolean | null;
  selfServiceAllowTransfer: boolean | null;
  selfServiceDeadlineHours: number | null;
  selfServiceMaxChanges: number | null;
}

/** Event override on top of the global setting (null = inherit; FALSE = off for the event). */
export function resolveSelfServicePolicy(
  global: TicketSelfServiceSettings,
  event: EventSelfServiceOverride,
): TicketSelfServiceSettings {
  if (event.selfServiceEnabled === false) return { ...global, enabled: false };
  const own = event.selfServiceEnabled === true;
  return {
    enabled: own ? true : global.enabled,
    allowNameChange: event.selfServiceAllowNameChange ?? global.allowNameChange,
    allowTransfer: event.selfServiceAllowTransfer ?? global.allowTransfer,
    deadlineHoursBeforeStart: event.selfServiceDeadlineHours ?? global.deadlineHoursBeforeStart,
    // NULL inherits, 0 = unlimited for this event (even when the global setting has a limit).
    maxChangesPerTicket:
      event.selfServiceMaxChanges === null
        ? global.maxChangesPerTicket
        : event.selfServiceMaxChanges === 0
          ? null
          : event.selfServiceMaxChanges,
  };
}

export interface SelfServiceFacts {
  policy: TicketSelfServiceSettings;
  startsAt: Date;
  now: Date;
  /** Customer changes already made for this seat (order item). */
  changesUsed: number;
  checkInState: 'NONE' | 'CHECKED_IN' | 'CHECKED_OUT';
  orderStatus: string;
  /** The ticket was already handed over to someone else. */
  isHolderTicket: boolean;
  /** Who asks: the buyer of the order or the current holder of a handed-over ticket. */
  actor: 'BUYER' | 'HOLDER';
  /** Transfers customers already made of this seat (against the hard ceiling). */
  transfersUsed: number;
}

/** Latest moment customers may still change a ticket. */
export function selfServiceDeadline(startsAt: Date, hours: number): Date {
  return new Date(startsAt.getTime() - hours * 3_600_000);
}

/** Pure decision: which customer actions are open for a ticket (null = allowed). */
export function evaluateSelfService(facts: SelfServiceFacts): {
  nameBlock: SelfServiceBlock | null;
  transferBlock: SelfServiceBlock | null;
} {
  const common = ((): SelfServiceBlock | null => {
    if (facts.orderStatus !== 'PAID' && facts.orderStatus !== 'PARTIALLY_REFUNDED') {
      return 'ORDER_NOT_PAID';
    }
    if (!facts.policy.enabled) return 'DISABLED';
    if (facts.checkInState !== 'NONE') return 'CHECKED_IN';
    const deadline = selfServiceDeadline(facts.startsAt, facts.policy.deadlineHoursBeforeStart);
    if (facts.now.getTime() > deadline.getTime()) return 'DEADLINE_PASSED';
    if (
      facts.policy.maxChangesPerTicket !== null &&
      facts.changesUsed >= facts.policy.maxChangesPerTicket
    ) {
      return 'LIMIT_REACHED';
    }
    return null;
  })();
  // Names of handed-over tickets are fixed (the buyer gave the recipient's name); only the
  // current holder may pass the ticket on, the buyer cannot touch it any more.
  let nameBlock: SelfServiceBlock | null = common;
  if (!nameBlock) {
    if (facts.isHolderTicket) nameBlock = 'HOLDER_TICKET';
    else if (!facts.policy.allowNameChange) nameBlock = 'NAME_CHANGE_DISABLED';
  }
  let transferBlock: SelfServiceBlock | null = common;
  if (!transferBlock) {
    if (facts.isHolderTicket && facts.actor === 'BUYER') transferBlock = 'HOLDER_TICKET';
    else if (!facts.policy.allowTransfer) transferBlock = 'TRANSFER_DISABLED';
    else if (facts.transfersUsed >= TRANSFER_CAPS.perTicket) transferBlock = 'LIMIT_REACHED';
  }
  return { nameBlock, transferBlock };
}

export interface TicketSelfServiceState {
  ticketId: string;
  orderItemId: string;
  /** Held by someone else (transferred): no download for the buyer, only "transfer again". */
  isHolderTicket: boolean;
  holderEmail: string | null;
  attendeeName: string | null;
  nameBlock: SelfServiceBlock | null;
  transferBlock: SelfServiceBlock | null;
  /** Latest time customers may change the ticket (null when the feature is off for the event). */
  deadlineAt: Date | null;
  changesUsed: number;
  maxChanges: number | null;
}

/** Customer changes (all kinds) and transfers made of each seat (order item). */
async function customerChangeCounts(
  db: Executor,
  orderItemIds: string[],
): Promise<Map<string, { changes: number; transfers: number }>> {
  if (orderItemIds.length === 0) return new Map();
  const rows = await db
    .select({
      orderItemId: ticketChanges.orderItemId,
      changes: count(),
      transfers: sql<number>`count(*) filter (where ${ticketChanges.kind} = 'TRANSFER')`,
    })
    .from(ticketChanges)
    .where(
      and(inArray(ticketChanges.orderItemId, orderItemIds), eq(ticketChanges.actor, 'CUSTOMER')),
    )
    .groupBy(ticketChanges.orderItemId);
  return new Map(
    rows.map((r) => [
      r.orderItemId,
      { changes: Number(r.changes), transfers: Number(r.transfers) },
    ]),
  );
}

/** What the order page offers per VALID ticket of an order (including tickets handed over). */
export async function getTicketSelfServiceStates(
  ctx: CoreContext,
  orderId: string,
  now = new Date(),
): Promise<TicketSelfServiceState[]> {
  const global = await getSetting(ctx, 'ticketSelfService');
  const [order] = await ctx.db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return [];
  const rows = await ctx.db
    .select({
      ticketId: tickets.id,
      orderItemId: tickets.orderItemId,
      holderEmail: tickets.holderEmail,
      attendeeName: tickets.attendeeName,
      checkInState: tickets.checkInState,
      startsAt: events.startsAt,
      selfServiceEnabled: events.selfServiceEnabled,
      selfServiceAllowNameChange: events.selfServiceAllowNameChange,
      selfServiceAllowTransfer: events.selfServiceAllowTransfer,
      selfServiceDeadlineHours: events.selfServiceDeadlineHours,
      selfServiceMaxChanges: events.selfServiceMaxChanges,
    })
    .from(tickets)
    .innerJoin(orderItems, eq(orderItems.id, tickets.orderItemId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID')))
    .orderBy(...placeOrderBy());
  const used = await customerChangeCounts(
    ctx.db,
    rows.map((r) => r.orderItemId),
  );
  return rows.map((row) => {
    const policy = resolveSelfServicePolicy(global, row);
    const changesUsed = used.get(row.orderItemId)?.changes ?? 0;
    const { nameBlock, transferBlock } = evaluateSelfService({
      policy,
      startsAt: row.startsAt,
      now,
      changesUsed,
      checkInState: row.checkInState,
      orderStatus: order.status,
      isHolderTicket: row.holderEmail !== null,
      actor: 'BUYER',
      transfersUsed: used.get(row.orderItemId)?.transfers ?? 0,
    });
    return {
      ticketId: row.ticketId,
      orderItemId: row.orderItemId,
      isHolderTicket: row.holderEmail !== null,
      holderEmail: row.holderEmail,
      attendeeName: row.attendeeName,
      nameBlock,
      transferBlock,
      deadlineAt: policy.enabled
        ? selfServiceDeadline(row.startsAt, policy.deadlineHoursBeforeStart)
        : null,
      changesUsed,
      maxChanges: policy.maxChangesPerTicket,
    };
  });
}

// ── Input ─────────────────────────────────────────────────────────────────────

const attendeeNameSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(120)
      .refine((v) => !/[\u0000-\u001f\u007f]/u.test(v)),
  );
const recipientEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const messageSchema = z
  .string()
  .transform((v) => v.replace(/\r\n/g, '\n').trim())
  .pipe(
    z
      .string()
      .max(500)
      // Line breaks are fine, other control characters are not.
      .refine((v) => !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(v)),
  );

export const changeAttendeeNameInput = z.object({ name: attendeeNameSchema });
export const transferTicketInput = z.object({
  recipientName: attendeeNameSchema,
  recipientEmail: recipientEmailSchema,
  message: messageSchema.nullish(),
});

/** CUSTOMER = the buyer of the order, HOLDER = the recipient of a handed-over ticket. */
export type TicketActor =
  { type: 'CUSTOMER' } | { type: 'HOLDER' } | { type: 'ADMIN'; userId: string };
const actorKind = (actor: TicketActor): TicketChangeActor =>
  actor.type === 'ADMIN' ? 'ADMIN' : 'CUSTOMER';
const actorUser = (actor: TicketActor) => (actor.type === 'ADMIN' ? actor.userId : null);

// ── Holder access (recipient of a transferred ticket) ─────────────────────────

/**
 * Resolves a holder link. A re-issue for the SAME holder (seat change, key rotation) keeps the
 * link working; a transfer to someone else, a cancellation or a refund ends it ("TRANSFERRED" /
 * "VOID" tombstone, never the new holder's ticket).
 */
export async function resolveHolderTicket(
  ctx: CoreContext,
  ticketId: string,
): Promise<{ row: TicketRow; state: 'VALID' | 'TRANSFERRED' | 'VOID' } | null> {
  const [first] = await ctx.db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!first || first.holderEmail === null) return null;
  let current = first;
  for (let hop = 0; hop < 8; hop += 1) {
    if (current.status === 'VALID') return { row: current, state: 'VALID' };
    if (current.status !== 'REPLACED' || !current.replacedByTicketId) {
      return { row: current, state: 'VOID' };
    }
    const [next] = await ctx.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, current.replacedByTicketId));
    if (!next) return { row: current, state: 'VOID' };
    if (next.holderEmail !== first.holderEmail) return { row: current, state: 'TRANSFERRED' };
    current = next;
  }
  return { row: current, state: 'VOID' };
}

export interface HolderTicketView {
  /** The ticket the link currently resolves to (follows re-issues for the same holder). */
  ticketId: string;
  state: 'VALID' | 'TRANSFERRED' | 'VOID';
  ticketCode: string;
  attendeeName: string | null;
  orderNumber: string;
  eventTitle: string;
  startsAt: Date;
  timeZone: string;
  venue: string;
  place: string;
  locale: string;
  wallet: { apple: boolean; google: boolean };
  /** Whether the holder may pass the ticket on (never rename it) and until when. */
  transfer: { block: SelfServiceBlock | null; deadlineAt: Date | null };
}

/** Transfer state of the holder of a (VALID) handed-over ticket. */
async function holderTransferState(
  ctx: CoreContext,
  ticket: TicketRow,
  now = new Date(),
): Promise<{ block: SelfServiceBlock | null; deadlineAt: Date | null }> {
  const global = await getSetting(ctx, 'ticketSelfService');
  const [row] = await ctx.db
    .select({
      status: orders.status,
      startsAt: events.startsAt,
      selfServiceEnabled: events.selfServiceEnabled,
      selfServiceAllowNameChange: events.selfServiceAllowNameChange,
      selfServiceAllowTransfer: events.selfServiceAllowTransfer,
      selfServiceDeadlineHours: events.selfServiceDeadlineHours,
      selfServiceMaxChanges: events.selfServiceMaxChanges,
    })
    .from(tickets)
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .where(eq(tickets.id, ticket.id));
  if (!row) return { block: 'DISABLED', deadlineAt: null };
  const policy = resolveSelfServicePolicy(global, row);
  const used = (await customerChangeCounts(ctx.db, [ticket.orderItemId])).get(ticket.orderItemId);
  const { transferBlock } = evaluateSelfService({
    policy,
    startsAt: row.startsAt,
    now,
    changesUsed: used?.changes ?? 0,
    checkInState: ticket.checkInState,
    orderStatus: row.status,
    isHolderTicket: ticket.holderEmail !== null,
    actor: 'HOLDER',
    transfersUsed: used?.transfers ?? 0,
  });
  return {
    block: transferBlock,
    deadlineAt: policy.enabled
      ? selfServiceDeadline(row.startsAt, policy.deadlineHoursBeforeStart)
      : null,
  };
}

/** Ticket page data for the recipient; null when the token does not belong to a holder ticket. */
export async function getHolderTicketView(
  ctx: CoreContext,
  token: string | null | undefined,
  requestedTicketId: string,
): Promise<HolderTicketView | null> {
  const tokenTicketId = verifyHolderTicketToken(ctx, token);
  if (!tokenTicketId || tokenTicketId !== requestedTicketId) return null;
  const resolved = await resolveHolderTicket(ctx, tokenTicketId);
  if (!resolved) return null;
  const [data] = await loadWalletTicketData(ctx.db, { ticketId: resolved.row.id });
  const [info] = await ctx.db
    .select({
      locale: orders.locale,
      orderNumber: orders.orderNumber,
      isTest: orders.isTest,
      title: events.title,
      startsAt: events.startsAt,
      timeZone: events.timeZone,
    })
    .from(tickets)
    .innerJoin(orders, eq(orders.id, tickets.orderId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .where(eq(tickets.id, resolved.row.id));
  if (!info) return null;
  const t = mailTranslator(info.locale);
  const wallet = info.isTest ? { apple: false, google: false } : await walletAvailability(ctx);
  return {
    ticketId: resolved.row.id,
    state: resolved.state,
    ticketCode: resolved.row.ticketCode,
    attendeeName: resolved.row.attendeeName,
    orderNumber: info.orderNumber,
    eventTitle: data?.eventTitle ?? info.title,
    startsAt: info.startsAt,
    timeZone: info.timeZone,
    venue: data ? [data.venueName, data.venueAddress].filter(Boolean).join(', ') : '',
    place: data ? walletPlaceLabel(data, t) : '',
    locale: info.locale,
    wallet,
    transfer:
      resolved.state === 'VALID'
        ? await holderTransferState(ctx, resolved.row)
        : { block: 'NOT_VALID' as const, deadlineAt: null },
  };
}

// ── Operations ────────────────────────────────────────────────────────────────

interface LockedTicket {
  ticket: TicketRow;
  order: typeof orders.$inferSelect;
}

/** Loads and locks everything a change depends on; throws when the actor may not change the ticket. */
async function lockAndAuthorize(
  ctx: CoreContext,
  tx: Transaction,
  params: { orderId: string; ticketId: string; actor: TicketActor; action: 'NAME' | 'TRANSFER' },
): Promise<LockedTicket> {
  await lockOrderTickets(tx, params.orderId);
  const [order] = await tx.select().from(orders).where(eq(orders.id, params.orderId)).for('share');
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  const [ticket] = await tx
    .select()
    .from(tickets)
    .where(eq(tickets.id, params.ticketId))
    .for('update');
  // Ownership: the ticket must belong to the order the caller proved access to.
  if (!ticket || ticket.orderId !== params.orderId) {
    throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  }
  if (ticket.status !== 'VALID') {
    throw new DomainError('TICKET_NOT_VALID', 'This ticket is no longer valid', 409);
  }
  // A holder acts on a handed-over ticket only.
  if (params.actor.type === 'HOLDER' && ticket.holderEmail === null) {
    throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  }
  if (order.status !== 'PAID' && order.status !== 'PARTIALLY_REFUNDED') {
    throw new DomainError('ORDER_NOT_PAID', 'Tickets of this order cannot be changed', 409);
  }
  if (ticket.checkInState !== 'NONE') {
    throw new DomainError('TICKET_CHECKED_IN', 'This ticket has already been used', 409);
  }
  const [event] = await tx.select().from(events).where(eq(events.id, ticket.eventId));
  if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  if (params.actor.type !== 'ADMIN') {
    const global = await getSetting(ctx, 'ticketSelfService');
    const used = (await customerChangeCounts(tx, [ticket.orderItemId])).get(ticket.orderItemId);
    const { nameBlock, transferBlock } = evaluateSelfService({
      policy: resolveSelfServicePolicy(global, event),
      startsAt: event.startsAt,
      now: new Date(),
      changesUsed: used?.changes ?? 0,
      checkInState: ticket.checkInState,
      orderStatus: order.status,
      isHolderTicket: ticket.holderEmail !== null,
      actor: params.actor.type === 'HOLDER' ? 'HOLDER' : 'BUYER',
      transfersUsed: used?.transfers ?? 0,
    });
    const block = params.action === 'NAME' ? nameBlock : transferBlock;
    if (block) {
      throw new DomainError(
        'SELF_SERVICE_NOT_ALLOWED',
        `This change is not possible (${block})`,
        409,
        { reason: block },
      );
    }
  }
  return { ticket, order };
}

export interface ChangeAttendeeNameResult {
  ticketId: string;
  attendeeName: string;
  changed: boolean;
}

/** Changes the attendee name of a ticket. The QR payload does not contain the name – no re-issue. */
export async function changeAttendeeName(
  ctx: CoreContext,
  params: { orderId: string; ticketId: string; name: string; actor: TicketActor },
): Promise<ChangeAttendeeNameResult> {
  const name = attendeeNameSchema.parse(params.name);
  const outcome = await withTransaction(ctx.db, async (tx) => {
    const { ticket } = await lockAndAuthorize(ctx, tx, { ...params, action: 'NAME' });
    if ((ticket.attendeeName ?? '') === name) return { changed: false, ticket };
    // The tickets trigger bumps sync_version / sync_xid for this UPDATE: scanners see the new name.
    await tx.update(tickets).set({ attendeeName: name }).where(eq(tickets.id, ticket.id));
    await tx.insert(ticketChanges).values({
      orderId: params.orderId,
      orderItemId: ticket.orderItemId,
      ticketId: ticket.id,
      newTicketId: ticket.id,
      kind: 'NAME_CHANGE',
      actor: actorKind(params.actor),
      actorUserId: actorUser(params.actor),
      oldName: ticket.attendeeName,
      newName: name,
    });
    await tx.insert(orderHistory).values({
      orderId: params.orderId,
      type: 'ticket_name_changed',
      actorType: params.actor.type === 'ADMIN' ? 'ADMIN' : 'CUSTOMER',
      actorUserId: actorUser(params.actor),
      data: { ticketId: ticket.id, ticketCode: ticket.ticketCode },
    });
    return { changed: true, ticket };
  });
  if (outcome.changed) {
    await discardRenderedFiles(ctx, params.orderId, [params.ticketId]);
    if (outcome.ticket.googleWalletObjectId) {
      // Existing Google Wallet passes are updated in place. Apple passes cannot be pushed
      // without APNs: they keep the old name until the pass is added again.
      await ensureGoogleSaveUrl(ctx, params.ticketId).catch((err) =>
        coreLog.warn(
          { err, ticketId: params.ticketId },
          '[self-service] Google Wallet update failed',
        ),
      );
    }
  }
  return { ticketId: params.ticketId, attendeeName: name, changed: outcome.changed };
}

export interface TransferTicketResult {
  oldTicketId: string;
  newTicketId: string;
  /** An admin handed the ticket back to the buyer (no holder any more). */
  returnedToBuyer: boolean;
}

/** Shortened single-line name for e-mail bodies (never user-controlled text beyond this). */
const mailName = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

interface TransferMailContext {
  order: typeof orders.$inferSelect;
  ticket: {
    id: string;
    eventId: string;
    orderId: string;
    ticketCode: string;
    attendeeName: string | null;
  };
  holderEmail: string;
  message: string | null;
  /** Name shown as the sender: the buyer, or the previous holder when a holder passed it on. */
  senderName: string;
}

/** Variables of both transfer e-mails; the recipient mail never contains an order link. */
async function transferVariables(
  ctx: CoreContext,
  db: Executor,
  m: TransferMailContext,
): Promise<Record<string, string | null>> {
  const base = await holderTicketVariables(ctx, db, m.ticket, m.order, { links: true });
  if (!base.ticketCode) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  return {
    ...base,
    senderName: mailName(m.senderName) || mailName(m.order.email) || '',
    transferMessage: m.message,
    newHolderEmail: m.holderEmail,
    orderNumber: m.order.orderNumber,
  };
}

const buyerName = (order: typeof orders.$inferSelect): string =>
  `${order.firstName} ${order.lastName}`.trim();

/** Addresses that identify the buyer: the order's e-mail and the owning customer account. */
async function buyerAddresses(
  tx: Executor,
  order: typeof orders.$inferSelect,
): Promise<Set<string>> {
  const addresses = new Set<string>();
  if (order.email) addresses.add(order.email.trim().toLowerCase());
  if (order.customerId) {
    const [customer] = await tx
      .select({ email: customers.email })
      .from(customers)
      .where(eq(customers.id, order.customerId));
    if (customer?.email) addresses.add(customer.email.trim().toLowerCase());
  }
  return addresses;
}

/** Hard ceilings (customers only): see `TRANSFER_CAPS`. Runs under the per-order ticket lock. */
async function assertTransferCaps(
  tx: Transaction,
  params: { orderId: string; orderItemId: string; recipientEmail: string },
): Promise<void> {
  // Serialise the per-recipient count across orders (the order lock only covers one order).
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`transfer-to:${params.recipientEmail}`}))`,
  );
  const since = new Date(Date.now() - DAY_MS);
  const counted = async (where: ReturnType<typeof and>) => {
    const [row] = await tx
      .select({ n: count() })
      .from(ticketChanges)
      .where(and(eq(ticketChanges.kind, 'TRANSFER'), eq(ticketChanges.actor, 'CUSTOMER'), where));
    return Number(row?.n ?? 0);
  };
  const limited = (reason: string) =>
    new DomainError(
      'TRANSFER_LIMIT_REACHED',
      'Too many tickets were passed on – please try again later or contact the organiser',
      429,
      { reason },
    );
  if (
    (await counted(eq(ticketChanges.orderItemId, params.orderItemId))) >= TRANSFER_CAPS.perTicket
  ) {
    throw limited('TICKET');
  }
  if (
    (await counted(
      and(eq(ticketChanges.orderId, params.orderId), gte(ticketChanges.createdAt, since)),
    )) >= TRANSFER_CAPS.perOrderPerDay
  ) {
    throw limited('ORDER');
  }
  if (
    (await counted(
      and(
        eq(ticketChanges.recipientEmail, params.recipientEmail),
        gte(ticketChanges.createdAt, since),
      ),
    )) >= TRANSFER_CAPS.perRecipientPerDay
  ) {
    throw limited('RECIPIENT');
  }
}

/**
 * Hands a ticket over: the old ticket becomes REPLACED (scanners reject its QR after their next
 * sync), a new ticket with a new id / QR / code is issued for the same seat and bound to the
 * recipient. The recipient gets an e-mail with a ticket-only link, the buyer a confirmation, a
 * previous holder is told that the ticket is gone.
 *
 * Who may: the buyer (while the ticket is still theirs), the current holder (to pass it on) and
 * admins (always). An admin who "transfers" to the buyer's own address hands the ticket back:
 * no holder, attendee = buyer name.
 */
export async function transferTicket(
  ctx: CoreContext,
  params: {
    orderId: string;
    ticketId: string;
    recipientName: string;
    recipientEmail: string;
    message?: string | null;
    actor: TicketActor;
  },
): Promise<TransferTicketResult> {
  const input = transferTicketInput.parse({
    recipientName: params.recipientName,
    recipientEmail: params.recipientEmail,
    message: params.message,
  });
  const mails: string[] = [];
  const outcome = await withTransaction(ctx.db, async (tx) => {
    const { ticket, order } = await lockAndAuthorize(ctx, tx, { ...params, action: 'TRANSFER' });
    const isAdmin = params.actor.type === 'ADMIN';
    const toBuyer = (await buyerAddresses(tx, order)).has(input.recipientEmail);
    if (toBuyer && !isAdmin) {
      throw new DomainError('SELF_TRANSFER', 'The recipient is the buyer of this order', 422);
    }
    if (ticket.holderEmail && input.recipientEmail === ticket.holderEmail) {
      throw new DomainError('SAME_HOLDER', 'The ticket already belongs to this recipient', 422);
    }
    if (toBuyer && ticket.holderEmail === null) {
      throw new DomainError('SAME_HOLDER', 'The ticket already belongs to the buyer', 422);
    }
    if (!isAdmin) {
      await assertTransferCaps(tx, {
        orderId: params.orderId,
        orderItemId: ticket.orderItemId,
        recipientEmail: input.recipientEmail,
      });
    }
    const handBack = toBuyer; // only reachable for admins
    const newName = handBack ? buyerName(order) || input.recipientName : input.recipientName;
    const created = await reissueTicketInTransaction(ctx, tx, ticket.id, {
      attendeeName: newName,
      holderEmail: handBack ? null : input.recipientEmail,
      notifyHolder: false,
    });
    const message = handBack ? null : input.message?.trim() || null;
    await tx.insert(ticketChanges).values({
      orderId: params.orderId,
      orderItemId: ticket.orderItemId,
      ticketId: ticket.id,
      newTicketId: created.id,
      kind: 'TRANSFER',
      actor: actorKind(params.actor),
      actorUserId: actorUser(params.actor),
      oldName: ticket.attendeeName,
      newName,
      recipientEmail: input.recipientEmail,
      message,
    });
    await tx.insert(orderHistory).values({
      orderId: params.orderId,
      type: 'ticket_transferred',
      actorType: isAdmin ? 'ADMIN' : 'CUSTOMER',
      actorUserId: actorUser(params.actor),
      data: {
        ticketId: ticket.id,
        newTicketId: created.id,
        ticketCode: created.ticketCode,
        ...(handBack ? { returnedToBuyer: true } : {}),
      },
    });

    // E-mails: outbox rows in the same transaction, dispatched after the commit.
    // A previous holder learns that the ticket is gone (unless they passed it on themselves).
    if (ticket.holderEmail && params.actor.type !== 'HOLDER') {
      const id = await queueHolderCancelledMail(ctx, tx, holderRef(ticket));
      if (id) mails.push(id);
    }
    if (handBack) {
      // The ticket is the buyer's again: send it to them.
      if (order.email) {
        mails.push(
          await createEmailMessage(ctx, tx, {
            key: 'TICKETS_RESENT',
            orderId: params.orderId,
            eventId: ticket.eventId,
          }),
        );
      }
    } else {
      const variables = await transferVariables(ctx, tx, {
        order,
        ticket: created,
        holderEmail: input.recipientEmail,
        message,
        senderName: params.actor.type === 'HOLDER' ? (ticket.attendeeName ?? '') : buyerName(order),
      });
      // No orderId: the recipient's mail must never carry the order link or buyer details.
      mails.push(
        await createEmailMessage(ctx, tx, {
          key: 'TICKET_TRANSFER_RECEIVED',
          to: input.recipientEmail,
          locale: order.locale,
          eventId: ticket.eventId,
          sourceOrderId: params.orderId,
          variables,
        }),
      );
      // The buyer's confirmation is about the buyer's own hand-over; a holder passing the ticket on
      // is not reported to the buyer (the mail would also reveal the new holder's address).
      if (order.email && params.actor.type !== 'HOLDER') {
        mails.push(
          await createEmailMessage(ctx, tx, {
            key: 'TICKET_TRANSFER_SENT',
            orderId: params.orderId,
            eventId: ticket.eventId,
            variables: { ...variables, transferMessage: null },
          }),
        );
      }
    }
    return { oldTicketId: ticket.id, newTicketId: created.id, returnedToBuyer: handBack };
  });

  await discardRenderedFiles(ctx, params.orderId, [outcome.oldTicketId]);
  await deactivateGoogleWalletObjects(ctx, { orderId: params.orderId });
  await dispatchMessages(ctx, mails);
  return outcome;
}

/**
 * The current holder passes a handed-over ticket on (the token proves possession of the ticket
 * link). Same deadline, limits and policy as for the buyer; the holder cannot rename the ticket.
 */
export async function transferTicketAsHolder(
  ctx: CoreContext,
  params: {
    token: string | null | undefined;
    ticketId: string;
    recipientName: string;
    recipientEmail: string;
    message?: string | null;
  },
): Promise<TransferTicketResult> {
  const tokenTicketId = verifyHolderTicketToken(ctx, params.token);
  if (!tokenTicketId || tokenTicketId !== params.ticketId) {
    throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  }
  const resolved = await resolveHolderTicket(ctx, tokenTicketId);
  if (!resolved) throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  if (resolved.state !== 'VALID') {
    throw new DomainError('TICKET_NOT_VALID', 'This ticket is no longer valid', 409);
  }
  return transferTicket(ctx, {
    orderId: resolved.row.orderId,
    ticketId: resolved.row.id,
    recipientName: params.recipientName,
    recipientEmail: params.recipientEmail,
    message: params.message,
    actor: { type: 'HOLDER' },
  });
}

/** Sends the recipient's ticket e-mail again (admin). Same ticket, same link. */
export async function resendHolderTicketMail(
  ctx: CoreContext,
  params: { orderId: string; ticketId: string },
): Promise<void> {
  const [ticket] = await ctx.db.select().from(tickets).where(eq(tickets.id, params.ticketId));
  if (
    !ticket ||
    ticket.orderId !== params.orderId ||
    ticket.status !== 'VALID' ||
    !ticket.holderEmail
  ) {
    throw new DomainError('TICKET_NOT_FOUND', 'Ticket not found', 404);
  }
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, params.orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  const variables = await transferVariables(ctx, ctx.db, {
    order,
    ticket,
    holderEmail: ticket.holderEmail,
    message: null,
    senderName: buyerName(order),
  });
  const messageId = await withTransaction(ctx.db, (tx) =>
    createEmailMessage(ctx, tx, {
      key: 'TICKET_TRANSFER_RECEIVED',
      to: ticket.holderEmail!,
      locale: order.locale,
      eventId: ticket.eventId,
      sourceOrderId: params.orderId,
      variables,
    }),
  );
  await dispatchEmailMessage(ctx, messageId);
}

/**
 * Drops generated files that contain the old holder data: the stored order PDF (all tickets of the
 * order reference the same object) and the cached Apple pass of the given tickets. They are rendered
 * again on demand. Best effort – the change itself is already committed.
 */
async function discardRenderedFiles(
  ctx: CoreContext,
  orderId: string,
  ticketIds: string[],
): Promise<void> {
  try {
    const rows = await ctx.db
      .select({ id: tickets.id, pdf: tickets.pdfObjectKey, pkpass: tickets.pkpassObjectKey })
      .from(tickets)
      .where(eq(tickets.orderId, orderId));
    const keys = new Set<string>();
    for (const r of rows) {
      if (r.pdf) keys.add(r.pdf);
      if (r.pkpass && ticketIds.includes(r.id)) keys.add(r.pkpass);
    }
    await ctx.db.update(tickets).set({ pdfObjectKey: null }).where(eq(tickets.orderId, orderId));
    await ctx.db
      .update(tickets)
      .set({ pkpassObjectKey: null })
      .where(inArray(tickets.id, ticketIds));
    if (ctx.storage) {
      for (const key of keys) {
        await ctx.storage.delete('documents', key).catch(() => undefined);
      }
    }
  } catch (err) {
    coreLog.warn({ err, orderId }, '[self-service] could not discard rendered files');
  }
}

// ── History (admin order page) ────────────────────────────────────────────────

export interface TicketChangeRow {
  id: string;
  kind: 'NAME_CHANGE' | 'TRANSFER';
  actor: 'CUSTOMER' | 'ADMIN';
  ticketId: string;
  newTicketId: string;
  oldName: string | null;
  newName: string | null;
  recipientEmail: string | null;
  message: string | null;
  createdAt: Date;
}

export async function listTicketChanges(
  ctx: CoreContext,
  orderId: string,
): Promise<TicketChangeRow[]> {
  const rows = await ctx.db
    .select()
    .from(ticketChanges)
    .where(eq(ticketChanges.orderId, orderId))
    .orderBy(desc(ticketChanges.createdAt), asc(ticketChanges.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actor: r.actor,
    ticketId: r.ticketId,
    newTicketId: r.newTicketId,
    oldName: r.oldName,
    newName: r.newName,
    recipientEmail: r.recipientEmail,
    message: r.message,
    createdAt: r.createdAt,
  }));
}
