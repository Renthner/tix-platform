import { orders, withTransaction, type Executor, type tickets } from '@tix/db';
import { eq } from 'drizzle-orm';
import type { CoreContext } from '../context';
import { createEmailMessage, dispatchEmailMessage } from '../email';
import { formatDateTime } from '../format';
import { mailTranslator } from '../i18n/mail-messages';
import { coreLog } from '../log';
import { loadWalletTicketData, walletPlaceLabel } from '../wallet/data';
import { walletAvailability } from '../wallet/links';
import { holderTicketUrls } from './holder';

/**
 * E-mails to the holder of a transferred ticket (the recipient, who is not the buyer). They carry
 * the ticket only - never an order link or buyer details - and are stored with the order id in the
 * mail envelope (`sourceOrderId`) so that a GDPR erasure of the buyer can find them.
 */

/** A ticket that has been handed over to someone else. */
export interface HolderTicketRef {
  id: string;
  orderId: string;
  eventId: string;
  ticketCode: string;
  attendeeName: string | null;
  holderEmail: string | null;
}

export const holderRef = (t: typeof tickets.$inferSelect): HolderTicketRef => ({
  id: t.id,
  orderId: t.orderId,
  eventId: t.eventId,
  ticketCode: t.ticketCode,
  attendeeName: t.attendeeName,
  holderEmail: t.holderEmail,
});

/** Variables describing the ticket itself (shared by the transfer, update and cancellation mails). */
export async function holderTicketVariables(
  ctx: CoreContext,
  db: Executor,
  ticket: { id: string },
  order: { locale: string; isTest: boolean },
  options: { links: boolean },
): Promise<Record<string, string | null>> {
  const [data] = await loadWalletTicketData(db, { ticketId: ticket.id });
  if (!data) return {};
  const t = mailTranslator(order.locale);
  const urls = options.links ? holderTicketUrls(ctx, ticket, order.locale) : null;
  const wallet =
    order.isTest || !urls ? { apple: false, google: false } : await walletAvailability(ctx);
  return {
    recipientName: data.attendeeName,
    ticketPlace: walletPlaceLabel(data, t),
    // "Your ticket" instead of "Your seat" in the templates (standing / admission tickets).
    ticketWithoutSeat: data.kind === 'GENERAL_ADMISSION' || !data.seat ? 'yes' : null,
    ticketCode: data.ticketCode,
    eventTitle: data.eventTitle,
    eventDate: formatDateTime(data.startsAt, order.locale, data.timeZone),
    eventVenue: data.venueName,
    ticketPageUrl: urls?.page ?? null,
    ticketPdfUrl: urls?.pdf ?? null,
    appleWalletUrl: wallet.apple && urls ? urls.pkpass : null,
    googleWalletUrl: wallet.google && urls ? urls.google : null,
  };
}

async function orderMeta(db: Executor, orderId: string) {
  const [order] = await db
    .select({ locale: orders.locale, isTest: orders.isTest })
    .from(orders)
    .where(eq(orders.id, orderId));
  return order ?? { locale: 'en', isTest: false };
}

/** "Your ticket was updated" (new QR code after a seat / tariff change or key rotation). */
export async function queueHolderUpdatedMail(
  ctx: CoreContext,
  tx: Executor,
  ticket: HolderTicketRef,
): Promise<string | null> {
  if (!ticket.holderEmail) return null;
  const order = await orderMeta(tx, ticket.orderId);
  return createEmailMessage(ctx, tx, {
    key: 'TICKET_HOLDER_UPDATED',
    to: ticket.holderEmail,
    locale: order.locale,
    eventId: ticket.eventId,
    sourceOrderId: ticket.orderId,
    variables: await holderTicketVariables(ctx, tx, ticket, order, { links: true }),
  });
}

/** "Your ticket is no longer valid" (cancellation, refund, reversal or re-assignment). */
export async function queueHolderCancelledMail(
  ctx: CoreContext,
  tx: Executor,
  ticket: HolderTicketRef,
): Promise<string | null> {
  if (!ticket.holderEmail) return null;
  const order = await orderMeta(tx, ticket.orderId);
  return createEmailMessage(ctx, tx, {
    key: 'TICKET_HOLDER_CANCELLED',
    to: ticket.holderEmail,
    locale: order.locale,
    eventId: ticket.eventId,
    sourceOrderId: ticket.orderId,
    variables: await holderTicketVariables(ctx, tx, ticket, order, { links: false }),
  });
}

/** Queues the cancellation mail for every holder in the caller's transaction; returns the ids. */
export async function queueHolderCancelledMails(
  ctx: CoreContext,
  tx: Executor,
  holders: readonly HolderTicketRef[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const ticket of holders) {
    const id = await queueHolderCancelledMail(ctx, tx, ticket);
    if (id) ids.push(id);
  }
  return ids;
}

/** Dispatches outbox rows after the commit. Never throws (the sweeper re-queues what fails). */
export async function dispatchMessages(ctx: CoreContext, ids: readonly string[]): Promise<void> {
  if (!ctx.jobs) return;
  for (const id of ids) {
    await dispatchEmailMessage(ctx, id).catch((err) =>
      coreLog.error({ err, messageId: id }, '[tickets] could not queue holder e-mail'),
    );
  }
}

/** Own-transaction variant for callers that are not inside one. */
export async function queueAndDispatchHolderUpdated(
  ctx: CoreContext,
  ticket: HolderTicketRef,
): Promise<void> {
  const id = await withTransaction(ctx.db, (tx) => queueHolderUpdatedMail(ctx, tx, ticket));
  if (id) await dispatchMessages(ctx, [id]);
}
