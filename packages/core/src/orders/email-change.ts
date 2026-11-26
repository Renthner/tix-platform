import {
  auditLogs,
  customers,
  emailMessages,
  events,
  orderAdjustments,
  orderHistory,
  orderItems,
  orders,
  withTransaction,
  type Transaction,
} from '@tix/db';
import { INVENTORY_HOLDING_ITEM_STATUSES, type EmailTemplateKey } from '@tix/shared';
import { and, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCapability, type CoreContext } from '../context';
import {
  createEmailMessage,
  dispatchEmailMessage,
  EMAIL_VARIABLES_CONTEXT,
  ORDER_EMAIL_OBSOLETE_ERROR,
  parseStoredEmailRequest,
} from '../email';
import { effectiveCheckoutConfig } from '../events';
import { coreLog } from '../log';

/**
 * Admin change of the buyer e-mail of an order (ONLY the e-mail: name and address stay as they
 * were invoiced, GoBD).
 *
 * In one transaction: the order moves to the customer record of the new address (created from the
 * order's buyer data when the address is new – an existing record is never modified, a registered
 * account is never touched), the access token version is bumped (every earlier order link dies),
 * history + audit entries are written and two outbox mails are created:
 *  - `ORDER_EMAIL_CHANGED` to the NEW address with the fresh order link,
 *  - `ORDER_EMAIL_CHANGED_OLD` to the previous address as a notice (rendered without the order, so
 *    it can never contain an order link, and without the new address – GDPR).
 * Mails of the order still queued/failed for the previous address are retired (FAILED, "obsolete")
 * – they would render the new order link; the delivery and the admin retry check this as well.
 * The important ones among them (order confirmation of an unpaid bank transfer, the payment
 * confirmation with the tickets of the current paid cycle, mails of an open additional payment)
 * are created again for the NEW address in the same transaction, so the buyer still gets them.
 * Orders whose contact data were erased (GDPR) are refused.
 *
 * Per-customer ticket limits of the new customer are checked like in the checkout; `overrideLimits`
 * lets an admin knowingly exceed them.
 */
const emailSchema = z.email().max(254);

export interface ChangeOrderEmailParams {
  orderId: string;
  newEmail: string;
  userId: string;
  overrideLimits?: boolean;
  /** Optimistic concurrency guard against a stale admin page. */
  expectedVersion?: number;
}

export async function changeOrderEmail(
  ctx: CoreContext,
  params: ChangeOrderEmailParams,
): Promise<{ previousEmail: string | null; newEmail: string; tokenVersion: number }> {
  const parsed = emailSchema.safeParse(params.newEmail.trim());
  if (!parsed.success) throw new DomainError('INVALID_EMAIL', 'Invalid e-mail address', 422);
  const newEmail = parsed.data;

  const outcome = await withTransaction(ctx.db, async (tx) => {
    // Lock order like `processPaidOrder`: the payment-mail advisory lock BEFORE the order row
    // (taken again – re-entrantly – in `applyOrderEmailChange`).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`order-paid-mail:${params.orderId}`}))`,
    );
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (order.anonymizedAt) {
      throw new DomainError('ORDER_ANONYMIZED', 'The contact data of this order were erased', 409);
    }
    if (params.expectedVersion !== undefined && params.expectedVersion !== order.version) {
      throw new DomainError('ORDER_CHANGED', 'The order was changed in the meantime', 409);
    }
    if (order.email && order.email.trim().toLowerCase() === newEmail.toLowerCase()) {
      throw new DomainError('EMAIL_UNCHANGED', 'The e-mail address is the same', 409);
    }

    // The customer record of the new address (one per e-mail).
    let [customer] = await tx
      .select()
      .from(customers)
      .where(sql`lower(${customers.email}) = ${newEmail.toLowerCase()}`)
      .for('update');
    if (customer?.anonymizedAt) {
      throw new DomainError(
        'CUSTOMER_ANONYMIZED',
        'This address belongs to an erased customer',
        409,
      );
    }
    if (!customer) {
      [customer] = await tx
        .insert(customers)
        .values({
          email: newEmail,
          firstName: order.firstName,
          lastName: order.lastName,
          company: order.company,
          phone: order.phone,
          address: order.billingAddress,
          locale: order.locale,
        })
        .returning();
    }
    const customerId = customer!.id;

    // Ticket limit per customer and event (all active orders of the new customer + this order).
    if (!params.overrideLimits && order.customerId !== customerId) {
      const mine = await tx
        .select({ eventId: orderItems.eventId, n: count() })
        .from(orderItems)
        .where(
          and(
            eq(orderItems.orderId, order.id),
            inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
          ),
        )
        .groupBy(orderItems.eventId);
      for (const row of mine) {
        const [event] = await tx.select().from(events).where(eq(events.id, row.eventId));
        if (!event) continue;
        const max = (await effectiveCheckoutConfig(ctx, event)).maxTicketsPerCustomer;
        if (max === null) continue;
        const [other] = await tx
          .select({ n: count() })
          .from(orderItems)
          .innerJoin(orders, eq(orders.id, orderItems.orderId))
          .where(
            and(
              eq(orders.customerId, customerId),
              ne(orders.id, order.id),
              eq(orderItems.eventId, row.eventId),
              inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
            ),
          );
        if ((other?.n ?? 0) + row.n > max) {
          throw new DomainError('CUSTOMER_LIMIT', 'Ticket limit per customer reached', 422, {
            event: event.title,
            max,
            remaining: Math.max(0, max - (other?.n ?? 0)),
          });
        }
      }
    }

    return applyOrderEmailChange(ctx, tx, order, {
      newEmail,
      customerId,
      userId: params.userId,
      limitsOverridden: params.overrideLimits === true,
      changeMails: true,
    });
  });

  for (const id of outcome.messages) {
    if (!id) continue;
    await dispatchEmailMessage(ctx, id).catch((err: unknown) =>
      coreLog.error({ err }, '[order-email] mail stored but not queued (outbox retries)'),
    );
  }
  return { previousEmail: outcome.previousEmail, newEmail, tokenVersion: outcome.tokenVersion };
}

export interface ApplyOrderEmailChangeOptions {
  /** Validated, trimmed new address. */
  newEmail: string;
  /** Customer record the order belongs to afterwards (already locked / created by the caller). */
  customerId: string;
  userId: string | null;
  limitsOverridden: boolean;
  /**
   * `true`: the per-order mails `ORDER_EMAIL_CHANGED` (new address) + `ORDER_EMAIL_CHANGED_OLD`
   * (old address) are created. `false`: the caller sends its own summary (customer-level move).
   * Retired mails are re-created for the new address in both cases.
   */
  changeMails: boolean;
  /** Recorded in history + audit: `customer` when moved along with the customer's e-mail. */
  via?: 'order' | 'customer';
}

/**
 * The shared core of an order e-mail change, inside the caller's transaction. The caller has
 * taken the payment-mail advisory lock (`order-paid-mail:<id>`) and THEN locked the order row
 * (`FOR UPDATE`) – the order `processPaidOrder` uses, so the two cannot deadlock – checked that it is not anonymised and that the address
 * really changes, and resolved the target customer (and the ticket limits). This writes the order,
 * history + audit, retires the mails still waiting for the old address (re-creating the important
 * ones for the new address) and optionally creates the two change mails. Returns the ids of the
 * created outbox messages – dispatch them after the commit.
 *
 * Internal: used by `changeOrderEmail` and the customer-level move in `updateCustomerAsAdmin`.
 */
export async function applyOrderEmailChange(
  ctx: CoreContext,
  tx: Transaction,
  order: typeof orders.$inferSelect,
  options: ApplyOrderEmailChangeOptions,
): Promise<{ previousEmail: string | null; tokenVersion: number; messages: string[] }> {
  const { newEmail, customerId } = options;
  const via = options.via ?? 'order';
  const previousEmail = order.email;
  const [updated] = await tx
    .update(orders)
    .set({
      email: newEmail,
      customerId,
      tokenVersion: sql`${orders.tokenVersion} + 1`,
      version: sql`${orders.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, order.id))
    .returning({ tokenVersion: orders.tokenVersion });
  await tx.insert(orderHistory).values({
    orderId: order.id,
    type: 'email_changed',
    actorType: 'ADMIN',
    actorUserId: options.userId,
    data: {
      from: previousEmail,
      to: newEmail,
      customerChanged: order.customerId !== customerId,
      limitsOverridden: options.limitsOverridden,
      ...(via === 'customer' ? { viaCustomer: true } : {}),
    },
  });
  await tx.insert(auditLogs).values({
    actorType: 'ADMIN',
    actorUserId: options.userId,
    action: 'order.email_changed',
    entityType: 'order',
    entityId: order.id,
    changes: { before: { email: previousEmail }, after: { email: newEmail } },
    metadata: {
      orderNumber: order.orderNumber,
      ...(via === 'customer' ? { via: 'customer', customerId } : {}),
    },
  });

  // Mails of this order that still wait for the OLD address would render the new order link
  // (read at send time) to the old recipient: retire them (FAILED + "obsolete", like obsolete
  // additional-payment mails). The notice to the old address is created below, after this.
  const replacements: string[] = [];
  if (previousEmail) {
    // Serialise with the payment confirmation of `processPaidOrder` (same lock): it either
    // committed its mail before (retired + re-created here) or sees the re-created one. Already
    // held by the caller (advisory locks are re-entrant); kept so the routine is safe on its own.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`order-paid-mail:${order.id}`}))`);
    const retired = await tx
      .update(emailMessages)
      .set({ status: 'FAILED', lastError: ORDER_EMAIL_OBSOLETE_ERROR, updatedAt: new Date() })
      .where(
        and(
          eq(emailMessages.orderId, order.id),
          inArray(emailMessages.status, ['QUEUED', 'FAILED']),
          sql`lower(trim(${emailMessages.toEmail})) = ${previousEmail.trim().toLowerCase()}`,
          // Already retired for another reason (e.g. additional payment no longer open): keep
          // that reason and never re-create such a mail.
          sql`coalesce(${emailMessages.lastError}, '') NOT LIKE 'obsolete:%'`,
          or(
            isNull(emailMessages.templateKey),
            ne(emailMessages.templateKey, 'ORDER_EMAIL_CHANGED_OLD'),
          ),
        ),
      )
      .returning({
        templateKey: emailMessages.templateKey,
        attachments: emailMessages.attachments,
        paidCycle: emailMessages.paidCycle,
        createdAt: emailMessages.createdAt,
      });
    // Mails never sent because the old address was on a reserved example domain (demo orders):
    // nobody got them, so they are re-created for the new address as well (the rows stay
    // SKIPPED – that is what happened to them).
    const skipped = await tx
      .select({
        templateKey: emailMessages.templateKey,
        attachments: emailMessages.attachments,
        paidCycle: emailMessages.paidCycle,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.orderId, order.id),
          eq(emailMessages.status, 'SKIPPED'),
          sql`lower(trim(${emailMessages.toEmail})) = ${previousEmail.trim().toLowerCase()}`,
          or(
            isNull(emailMessages.templateKey),
            ne(emailMessages.templateKey, 'ORDER_EMAIL_CHANGED_OLD'),
          ),
        ),
      );
    replacements.push(
      ...(await recreateRetiredMails(ctx, tx, {
        order: { id: order.id, status: order.status, paidCycle: order.paidCycle },
        to: newEmail,
        retired: [...retired, ...skipped],
      })),
    );
  }

  const messages: string[] = [];
  if (options.changeMails) {
    // New address: confirmation with the fresh order link (order data are read at send time).
    messages.push(
      await createEmailMessage(ctx, tx, {
        key: 'ORDER_EMAIL_CHANGED',
        orderId: order.id,
        to: newEmail,
        variables: { previousEmail: previousEmail ?? '' },
      }),
    );
    // Old address: notice only, deliberately WITHOUT the order (no order link, no order data).
    if (previousEmail) {
      messages.push(
        await createEmailMessage(ctx, tx, {
          key: 'ORDER_EMAIL_CHANGED_OLD',
          to: previousEmail,
          locale: order.locale,
          sourceOrderId: order.id,
          // Never the new address (GDPR: the old mailbox may no longer belong to the buyer).
          variables: {
            firstName: order.firstName,
            orderNumber: order.orderNumber,
            previousEmail,
          },
        }),
      );
    }
  }
  return {
    previousEmail,
    tokenVersion: updated!.tokenVersion,
    messages: [...messages, ...replacements],
  };
}

/** Order mails that are created again for the new address when they were retired. */
const RECREATED_KEYS: ReadonlySet<EmailTemplateKey> = new Set([
  'ORDER_CONFIRMATION_BANK_TRANSFER',
  'PAYMENT_RECEIVED_TICKETS',
  'ADDITIONAL_PAYMENT_REQUEST',
  'ADDITIONAL_PAYMENT_REMINDER',
  'ADDITIONAL_PAYMENT_RECEIVED',
]);

/**
 * Re-creates the relevant retired mails (same template, variables and attachment envelope) for the
 * new address. One per template key (per additional payment for the additional-payment mails);
 * outdated ones are left retired: the bank-transfer confirmation of an order that is no longer
 * awaiting payment, a payment confirmation of an earlier paid cycle, mails of an additional
 * payment that is no longer open, messages whose variables were erased.
 */
async function recreateRetiredMails(
  ctx: CoreContext,
  tx: Transaction,
  params: {
    order: { id: string; status: string; paidCycle: number };
    to: string;
    retired: {
      templateKey: EmailTemplateKey | null;
      attachments: unknown;
      paidCycle: number | null;
      createdAt: Date;
    }[];
  },
): Promise<string[]> {
  const { order } = params;
  const newestFirst = [...params.retired].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of newestFirst) {
    const key = row.templateKey;
    if (!key || !RECREATED_KEYS.has(key)) continue;
    const payload = parseStoredEmailRequest(row.attachments);
    if (payload.purgedAt) continue;
    const variables = payload.variables
      ? requireCapability(ctx, 'secrets').decryptJson<Record<string, string | number | null>>(
          payload.variables,
          EMAIL_VARIABLES_CONTEXT,
        )
      : {};
    if (key === 'ORDER_CONFIRMATION_BANK_TRANSFER' && order.status !== 'AWAITING_PAYMENT') continue;
    if (key === 'PAYMENT_RECEIVED_TICKETS') {
      if ((row.paidCycle ?? 0) !== order.paidCycle) continue;
      if (order.status !== 'PAID' && order.status !== 'PARTIALLY_REFUNDED') continue;
    }
    const adjustmentId = typeof variables.adjustmentId === 'string' ? variables.adjustmentId : null;
    if (key.startsWith('ADDITIONAL_PAYMENT_') && key !== 'ADDITIONAL_PAYMENT_RECEIVED') {
      // Request / reminder: only while the additional payment is still open.
      if (!adjustmentId) continue;
      const [adjustment] = await tx
        .select({ status: orderAdjustments.status })
        .from(orderAdjustments)
        .where(eq(orderAdjustments.id, adjustmentId));
      if (!adjustment || (adjustment.status !== 'PROPOSED' && adjustment.status !== 'CONFIRMED')) {
        continue;
      }
    }
    const dedupe = `${key}:${adjustmentId ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const id = await createEmailMessage(ctx, tx, {
      key,
      orderId: order.id,
      to: params.to,
      locale: payload.locale ?? undefined,
      eventId: payload.eventId,
      customerId: payload.customerId,
      sourceOrderId: payload.sourceOrderId ?? null,
      variables,
      // Explicit (also when empty): the same envelope, never the automatic attachment lookup.
      attachments: payload.attachments,
    });
    if (key === 'PAYMENT_RECEIVED_TICKETS') {
      await tx
        .update(emailMessages)
        .set({ paidCycle: order.paidCycle })
        .where(eq(emailMessages.id, id));
    }
    ids.push(id);
  }
  return ids;
}
