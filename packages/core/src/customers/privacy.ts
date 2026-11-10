import {
  orderAdjustments,
  accessCodeRedemptions,
  bankTransactions,
  customerSessions,
  customerTokens,
  customers,
  emailMessages,
  erasures,
  orderHistory,
  webhookEvents,
  events,
  invoices,
  orderItems,
  orders,
  payments,
  refunds,
  tickets,
  withTransaction,
  type Executor,
} from '@tix/db';
import { and, asc, eq, inArray, isNotNull, notExists, or, sql, type SQL } from 'drizzle-orm';
import { verifyAdminPassword, type AdminActor } from '../admin-users';
import { DomainError, type CoreContext } from '../context';
import { EMAIL_VARIABLES_CONTEXT, parseStoredEmailRequest } from '../email/request';
import { getSetting } from '../settings';
import { orderTicketsObjectKey } from '../tickets/render';
import { writeCustomerAudit } from './admin';

/**
 * GDPR (DSGVO) data subject rights for customers: export (Art. 15) and erasure (Art. 17).
 *
 * Erasure keeps what the law requires us to keep (Art. 17(3)(b), § 147 AO / § 257 HGB):
 * - invoices and credit notes (immutable, incl. their buyer snapshot and PDFs),
 * - name, company and billing address on the *orders* that have invoices, until the end of the
 *   retention period (`privacy.invoiceRetentionYears` after the end of the invoice year; the
 *   date is stored in `orders.personal_data_retained_until` and the retention job erases the
 *   data afterwards),
 * - bank statement data (`bank_transactions`: counterparty name / IBAN / purpose) – bookkeeping
 *   records of the bank account,
 * - payment amounts, order totals, items, ticket codes (without names) and the audit trail
 *   (which never contains personal data values).
 * Everything else is erased or replaced by neutral placeholders.
 */

/** Keys whose values are personal data inside PayPal webhook payloads. */
const WEBHOOK_PERSONAL_KEYS =
  /^(payer|payer_info|payer_email|payment_source|shipping|shipping_address|billing_address|address|email|email_address|name|given_name|surname|full_name|phone|phone_number)$/i;
/** Keys that carry names, addresses or free text inside order history entries. */
const HISTORY_PERSONAL_KEYS =
  /^(reason|note|message|failure|email|phone|name|firstName|lastName|first_name|last_name|company|address|street|city|postalCode|billingAddress)$/i;

/** Replaces the values of keys matching `pattern` (recursively) with null. */
export function scrubJson(value: unknown, pattern: RegExp): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, pattern));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        pattern.test(k) && v !== null ? null : scrubJson(v, pattern),
      ]),
    );
  }
  return value;
}

const WEBHOOK_MARKER = 'tixScrubbed';

/** Scrubs the personal fields of the given webhook rows; returns how many were changed. */
async function scrubWebhookRows(
  db: Executor,
  rows: { id: string; payload: unknown }[],
): Promise<number> {
  for (const row of rows) {
    const next = {
      ...(scrubJson(row.payload, WEBHOOK_PERSONAL_KEYS) as Record<string, unknown>),
      [WEBHOOK_MARKER]: true,
    };
    await db.update(webhookEvents).set({ payload: next }).where(eq(webhookEvents.id, row.id));
  }
  return rows.length;
}

export const ANONYMIZED_EMAIL_DOMAIN = 'invalid';
export const anonymizedEmail = (customerId: string) =>
  `anonymized+${customerId}@${ANONYMIZED_EMAIL_DOMAIN}`;

// ─── Orders of a customer ─────────────────────────────────────────────────────────────

/**
 * Orders belonging to a customer: linked ones plus unlinked orders (box office) that carry the
 * customer's e-mail address.
 */
function customerOrders(customerId: string, email: string): SQL {
  return or(
    eq(orders.customerId, customerId),
    and(sql`${orders.customerId} IS NULL`, sql`lower(${orders.email}) = ${email.toLowerCase()}`),
  )!;
}

// ─── Blockers ─────────────────────────────────────────────────────────────────────────

export interface AnonymizationBlockers {
  openOrders: { orderId: string; orderNumber: string; status: string }[];
  futureTickets: {
    orderId: string;
    orderNumber: string;
    eventTitle: string;
    startsAt: Date;
    tickets: number;
  }[];
  openRefunds: { orderId: string; orderNumber: string; refundId: string; amount: number }[];
}

export const hasBlockers = (b: AnonymizationBlockers) =>
  b.openOrders.length + b.futureTickets.length + b.openRefunds.length > 0;

/** Why a customer cannot be anonymised right now (empty = allowed). */
export async function getAnonymizationBlockers(
  db: Executor,
  customerId: string,
  email: string,
): Promise<AnonymizationBlockers> {
  const mine = customerOrders(customerId, email);
  const [openOrders, futureTickets, openRefunds] = await Promise.all([
    db
      .select({ orderId: orders.id, orderNumber: orders.orderNumber, status: orders.status })
      .from(orders)
      .where(
        and(
          mine,
          or(
            inArray(orders.status, ['PENDING', 'AWAITING_PAYMENT']),
            // An open additional payment (tariff change) counts as an open order.
            sql`exists (select 1 from ${orderAdjustments} where ${orderAdjustments.orderId} = ${orders.id} and ${orderAdjustments.status} in ('PROPOSED','CONFIRMED'))`,
          ),
        ),
      )
      .orderBy(asc(orders.createdAt)),
    db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        eventTitle: events.title,
        startsAt: events.startsAt,
        tickets: sql<number>`count(*)::int`,
      })
      .from(tickets)
      .innerJoin(orders, eq(orders.id, tickets.orderId))
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(
        and(
          mine,
          eq(tickets.status, 'VALID'),
          sql`coalesce(${events.endsAt}, ${events.startsAt}) > now()`,
        ),
      )
      .groupBy(orders.id, orders.orderNumber, events.id, events.title, events.startsAt)
      .orderBy(asc(events.startsAt)),
    db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        refundId: refunds.id,
        amount: refunds.amount,
      })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(and(mine, inArray(refunds.status, ['PENDING', 'FAILED']))),
  ]);
  return { openOrders, futureTickets, openRefunds };
}

// ─── Export (Art. 15) ─────────────────────────────────────────────────────────────────

/** E-mail variables that carry links / tokens are never exported. */
function exportableVariables(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/url|link|token|secret|password/i.test(key)) continue;
    if (typeof value === 'string' && /https?:|token=|tix:\/\//i.test(value)) continue;
    out[key] = value;
  }
  return out;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Everything stored about a customer as a JSON-serialisable document. Secrets (password hash,
 * tokens, QR payloads / signatures, storage keys, provider responses, raw bank data) are left
 * out on purpose.
 */
export async function exportCustomerData(ctx: CoreContext, customerId: string) {
  const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
  const mine = customerOrders(customerId, customer.email);

  const orderRows = await ctx.db
    .select()
    .from(orders)
    .where(mine)
    .orderBy(asc(orders.createdAt), asc(orders.id));
  const orderIds = orderRows.map((o) => o.id);
  const byOrder = <T extends { orderId: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.orderId, [...(map.get(row.orderId) ?? []), row]);
    return map;
  };

  const [items, ticketRows, paymentRows, refundRows, invoiceRows, redemptions] =
    orderIds.length === 0
      ? [[], [], [], [], [], []]
      : await Promise.all([
          ctx.db
            .select({
              orderId: orderItems.orderId,
              event: events.title,
              eventStartsAt: events.startsAt,
              status: orderItems.status,
              section: orderItems.sectionLabel,
              row: orderItems.rowLabel,
              seat: orderItems.seatLabel,
              category: orderItems.categoryName,
              ticketType: orderItems.ticketTypeName,
              priceGross: orderItems.priceGross,
              attendeeName: orderItems.attendeeName,
            })
            .from(orderItems)
            .innerJoin(events, eq(events.id, orderItems.eventId))
            .where(inArray(orderItems.orderId, orderIds))
            .orderBy(asc(orderItems.createdAt), asc(orderItems.id)),
          ctx.db
            .select({
              orderId: tickets.orderId,
              ticketCode: tickets.ticketCode,
              status: tickets.status,
              event: events.title,
              attendeeName: tickets.attendeeName,
              issuedAt: tickets.issuedAt,
              checkInState: tickets.checkInState,
              firstCheckedInAt: tickets.firstCheckedInAt,
            })
            .from(tickets)
            .innerJoin(events, eq(events.id, tickets.eventId))
            .where(inArray(tickets.orderId, orderIds))
            .orderBy(asc(tickets.issuedAt), asc(tickets.id)),
          ctx.db
            .select({
              orderId: payments.orderId,
              method: payments.method,
              status: payments.status,
              amount: payments.amount,
              currency: payments.currency,
              capturedAt: payments.capturedAt,
              bankBookingDate: bankTransactions.bookingDate,
              bankCounterpartyName: bankTransactions.counterpartyName,
              bankCounterpartyIban: bankTransactions.counterpartyIban,
              bankRemittance: bankTransactions.remittanceInformation,
            })
            .from(payments)
            .leftJoin(bankTransactions, eq(bankTransactions.id, payments.bankTransactionId))
            .where(inArray(payments.orderId, orderIds))
            .orderBy(asc(payments.createdAt), asc(payments.id)),
          ctx.db
            .select({
              orderId: refunds.orderId,
              method: refunds.method,
              kind: refunds.kind,
              status: refunds.status,
              amount: refunds.amount,
              currency: refunds.currency,
              reason: refunds.reason,
              payerIban: refunds.payerIban,
              payerName: refunds.payerName,
              createdAt: refunds.createdAt,
              completedAt: refunds.completedAt,
            })
            .from(refunds)
            .where(inArray(refunds.orderId, orderIds))
            .orderBy(asc(refunds.createdAt), asc(refunds.id)),
          ctx.db
            .select({
              orderId: invoices.orderId,
              invoiceNumber: invoices.invoiceNumber,
              type: invoices.type,
              issuedAt: invoices.issuedAt,
              buyer: invoices.buyer,
              currency: invoices.currency,
              totalNet: invoices.totalNet,
              totalTax: invoices.totalTax,
              totalGross: invoices.totalGross,
            })
            .from(invoices)
            .where(inArray(invoices.orderId, orderIds))
            .orderBy(asc(invoices.issuedAt), asc(invoices.id)),
          ctx.db
            .select({
              orderId: accessCodeRedemptions.orderId,
              email: accessCodeRedemptions.email,
              ticketCount: accessCodeRedemptions.ticketCount,
              redeemedAt: accessCodeRedemptions.redeemedAt,
            })
            .from(accessCodeRedemptions)
            .where(inArray(accessCodeRedemptions.orderId, orderIds)),
        ]);

  const addresses = new Set([customer.email.toLowerCase()]);
  for (const o of orderRows) if (o.email) addresses.add(o.email.toLowerCase());
  const mailRows = await ctx.db
    .select({
      id: emailMessages.id,
      templateKey: emailMessages.templateKey,
      toEmail: emailMessages.toEmail,
      subject: emailMessages.subject,
      status: emailMessages.status,
      sentAt: emailMessages.sentAt,
      createdAt: emailMessages.createdAt,
      payload: emailMessages.attachments,
    })
    .from(emailMessages)
    .where(
      or(
        orderIds.length ? inArray(emailMessages.orderId, orderIds) : undefined,
        inArray(sql`lower(${emailMessages.toEmail})`, [...addresses]),
        sql`${emailMessages.attachments}->>'customerId' = ${customerId}`,
      ),
    )
    .orderBy(asc(emailMessages.createdAt), asc(emailMessages.id));
  const mails = mailRows.map((row) => {
    const stored = parseStoredEmailRequest(row.payload);
    let variables: Record<string, unknown> | null = null;
    if (stored.variables && ctx.secrets) {
      try {
        variables = exportableVariables(
          ctx.secrets.decryptJson<Record<string, unknown>>(
            stored.variables,
            EMAIL_VARIABLES_CONTEXT,
          ),
        );
      } catch {
        variables = null;
      }
    }
    return {
      template: row.templateKey,
      to: row.toEmail,
      subject: row.subject,
      status: row.status,
      sentAt: iso(row.sentAt ?? row.createdAt),
      attachedFiles: (stored.sentFiles ?? []).map((f) => f.fileName),
      variables,
    };
  });

  const itemsBy = byOrder(items);
  const ticketsBy = byOrder(ticketRows);
  const paymentsBy = byOrder(paymentRows);
  const refundsBy = byOrder(refundRows);
  const invoicesBy = byOrder(invoiceRows);
  const strip = <T extends { orderId: string | null }>(row: T) => {
    const { orderId: _orderId, ...rest } = row;
    return rest;
  };

  return {
    exportedAt: new Date().toISOString(),
    legalBasis: 'GDPR Art. 15 (right of access)',
    customer: {
      id: customer.id,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      company: customer.company,
      phone: customer.phone,
      address: customer.address,
      locale: customer.locale,
      marketingConsentAt: iso(customer.marketingConsentAt),
      createdAt: iso(customer.createdAt),
      anonymizedAt: iso(customer.anonymizedAt),
      account: {
        exists: customer.accountCreatedAt !== null,
        createdAt: iso(customer.accountCreatedAt),
        emailVerifiedAt: iso(customer.emailVerifiedAt),
        lastLoginAt: iso(customer.lastLoginAt),
      },
    },
    orders: orderRows.map((o) => ({
      orderNumber: o.orderNumber,
      createdAt: iso(o.createdAt),
      status: o.status,
      channel: o.channel,
      paymentMethod: o.paymentMethod,
      paymentReference: o.paymentReference,
      buyer: {
        email: o.email,
        firstName: o.firstName,
        lastName: o.lastName,
        company: o.company,
        phone: o.phone,
        billingAddress: o.billingAddress,
        locale: o.locale,
        ipAddress: o.ipAddress,
      },
      currency: o.currency,
      totalGross: o.totalGross,
      amountPaid: o.amountPaid,
      amountRefunded: o.amountRefunded,
      paidAt: iso(o.paidAt),
      cancelledAt: iso(o.cancelledAt),
      customerNote: o.customerNote,
      termsAcceptedAt: iso(o.termsAcceptedAt),
      items: (itemsBy.get(o.id) ?? []).map((r) => ({
        ...strip(r),
        eventStartsAt: iso(r.eventStartsAt),
      })),
      tickets: (ticketsBy.get(o.id) ?? []).map((r) => ({
        ...strip(r),
        issuedAt: iso(r.issuedAt),
        firstCheckedInAt: iso(r.firstCheckedInAt),
      })),
      payments: (paymentsBy.get(o.id) ?? []).map((r) => ({
        ...strip(r),
        capturedAt: iso(r.capturedAt),
      })),
      refunds: (refundsBy.get(o.id) ?? []).map((r) => ({
        ...strip(r),
        createdAt: iso(r.createdAt),
        completedAt: iso(r.completedAt),
      })),
      invoices: (invoicesBy.get(o.id) ?? []).map((r) => ({
        ...strip(r),
        issuedAt: iso(r.issuedAt),
      })),
    })),
    accessCodeRedemptions: redemptions.map((r) => ({
      ...strip(r),
      redeemedAt: iso(r.redeemedAt),
    })),
    emails: mails,
  };
}

export type CustomerDataExport = Awaited<ReturnType<typeof exportCustomerData>>;

/** Export + audit entry (ids and counts only). */
export async function exportCustomerDataAudited(
  ctx: CoreContext,
  actor: AdminActor,
  customerId: string,
): Promise<CustomerDataExport> {
  const data = await exportCustomerData(ctx, customerId);
  await writeCustomerAudit(ctx.db, actor, 'customer.gdpr_export', customerId, {
    orders: data.orders.length,
    emails: data.emails.length,
  });
  return data;
}

// ─── Erasure (Art. 17) ────────────────────────────────────────────────────────────────

export interface AnonymizationResult {
  alreadyAnonymized: boolean;
  orders: number;
  /** Orders whose billing data stays until `personal_data_retained_until` (invoices exist). */
  ordersRetained: number;
  emails: number;
  tickets: number;
  refunds: number;
  /** Stored payment webhooks and order history entries scrubbed. */
  webhooks: number;
  history: number;
}

const EMPTY_RESULT: AnonymizationResult = {
  alreadyAnonymized: true,
  orders: 0,
  ordersRetained: 0,
  emails: 0,
  tickets: 0,
  refunds: 0,
  webhooks: 0,
  history: 0,
};

/**
 * Anonymises a customer (see the module comment for what is kept). Requires the acting admin's
 * password. Blocked while the customer has open orders, open refunds or valid tickets for
 * events that have not ended (`ANONYMIZATION_BLOCKED`, details = the blockers). Idempotent.
 */
export async function anonymizeCustomer(
  ctx: CoreContext,
  actor: (AdminActor & { userId: string }) | null,
  customerId: string,
  /** `replay`: re-applies an erasure after a restore (no password, no blockers, no audit entry). */
  options: { password: string } | { replay: true },
): Promise<AnonymizationResult> {
  const replay = 'replay' in options;
  if (!replay) await verifyAdminPassword(ctx, actor!.userId, options.password);
  const { invoiceRetentionYears } = await getSetting(ctx, 'privacy');

  const result = await withTransaction(ctx.db, async (tx) => {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .for('update');
    if (!customer) throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
    if (customer.anonymizedAt) return { ...EMPTY_RESULT, storageKeys: [] as string[] };

    const blockers = await getAnonymizationBlockers(tx, customerId, customer.email);
    if (!replay && hasBlockers(blockers)) {
      throw new DomainError(
        'ANONYMIZATION_BLOCKED',
        'The customer still has open orders, open refunds or valid tickets for upcoming events',
        409,
        { blockers },
      );
    }

    const placeholder = anonymizedEmail(customerId);
    const orderRows = await tx
      .select({
        id: orders.id,
        email: orders.email,
        orderNumber: orders.orderNumber,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(customerOrders(customerId, customer.email));
    const orderIds = orderRows.map((o) => o.id);
    const addresses = new Set([customer.email.toLowerCase()]);
    for (const o of orderRows) if (o.email) addresses.add(o.email.toLowerCase());
    const addressList = [...addresses];
    const now = new Date();

    // ── E-mail log: recipient, stored variables, subject (may contain the name) ──
    const mails = await tx
      .update(emailMessages)
      .set({
        toEmail: placeholder,
        subject: sql`'[' || coalesce(${emailMessages.templateKey}::text, 'email') || ']'`,
        lastError: null,
        status: sql`CASE WHEN ${emailMessages.status} IN ('QUEUED', 'SENDING') THEN 'FAILED' ELSE ${emailMessages.status} END`,
        attachments: PURGED_ENVELOPE,
      })
      .where(
        or(
          orderIds.length ? inArray(emailMessages.orderId, orderIds) : undefined,
          inArray(sql`lower(${emailMessages.toEmail})`, addressList),
          sql`${emailMessages.attachments}->>'customerId' = ${customerId}`,
        ),
      )
      .returning({ id: emailMessages.id });

    // ── Access code redemptions ──
    await tx
      .update(accessCodeRedemptions)
      .set({ email: null })
      .where(
        or(
          orderIds.length ? inArray(accessCodeRedemptions.orderId, orderIds) : undefined,
          inArray(sql`lower(${accessCodeRedemptions.email})`, addressList),
        ),
      );

    let ticketCount = 0;
    let refundCount = 0;
    let webhookCount = 0;
    let historyCount = 0;
    let ordersRetained = 0;
    const storageKeys: string[] = [];
    if (orderIds.length > 0) {
      // ── Tickets: attendee names, rendered documents containing them ──
      // The stored file keys are read BEFORE they are nulled (UPDATE … RETURNING would only see NULLs).
      const keyRows = await tx
        .select({ pdf: tickets.pdfObjectKey, pkpass: tickets.pkpassObjectKey })
        .from(tickets)
        .where(inArray(tickets.orderId, orderIds));
      const ticketRows = await tx
        .update(tickets)
        .set({
          attendeeName: null,
          pdfObjectKey: null,
          pkpassObjectKey: null,
          googleWalletObjectId: null,
        })
        .where(inArray(tickets.orderId, orderIds))
        .returning();
      ticketCount = ticketRows.length;
      await tx
        .update(orderItems)
        .set({ attendeeName: null })
        .where(and(inArray(orderItems.orderId, orderIds), isNotNull(orderItems.attendeeName)));

      // ── Refund payer account (the refund itself is done: finished refunds only) ──
      const refundRows = await tx
        .update(refunds)
        .set({ payerIban: null, payerName: null })
        .where(and(inArray(refunds.orderId, orderIds), eq(refunds.status, 'SUCCEEDED')))
        .returning({ id: refunds.id });
      refundCount = refundRows.length;

      // ── PayPal payer details inside the stored provider response ──
      await tx
        .update(payments)
        .set({ providerResponse: sql`${payments.providerResponse} - 'payer' - 'payment_source'` })
        .where(
          and(
            inArray(payments.orderId, orderIds),
            sql`jsonb_typeof(${payments.providerResponse}) = 'object'`,
          ),
        );

      // ── Order history: names, e-mails, free-text reasons / notes ──
      const history = await tx
        .select({ id: orderHistory.id, data: orderHistory.data })
        .from(orderHistory)
        .where(and(inArray(orderHistory.orderId, orderIds), isNotNull(orderHistory.data)));
      for (const h of history) {
        const next = scrubJson(h.data, HISTORY_PERSONAL_KEYS);
        if (JSON.stringify(next) === JSON.stringify(h.data)) continue;
        await tx.update(orderHistory).set({ data: next }).where(eq(orderHistory.id, h.id));
        historyCount += 1;
      }

      // ── Stored payment webhooks of these payments / refunds (ids, type, amounts stay) ──
      const refs = await Promise.all([
        tx
          .select({ a: payments.providerCaptureId, b: payments.providerOrderId })
          .from(payments)
          .where(inArray(payments.orderId, orderIds)),
        tx
          .select({ a: refunds.providerRefundId })
          .from(refunds)
          .where(inArray(refunds.orderId, orderIds)),
      ]);
      const refIds = [
        ...new Set(
          [...refs[0].flatMap((r) => [r.a, r.b]), ...refs[1].map((r) => r.a)].filter(
            (v): v is string => Boolean(v),
          ),
        ),
      ];
      if (refIds.length > 0) {
        const hooks = await tx
          .select({ id: webhookEvents.id, payload: webhookEvents.payload })
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.provider, 'paypal'),
              sql`NOT (${webhookEvents.payload} ? ${WEBHOOK_MARKER})`,
              or(
                inArray(sql`${webhookEvents.payload}#>>'{resource,id}'`, refIds),
                inArray(
                  sql`${webhookEvents.payload}#>>'{resource,supplementary_data,related_ids,order_id}'`,
                  refIds,
                ),
                inArray(
                  sql`${webhookEvents.payload}#>>'{resource,supplementary_data,related_ids,capture_id}'`,
                  refIds,
                ),
              ),
            ),
          );
        webhookCount = await scrubWebhookRows(tx, hooks);
      }

      // ── Orders ──
      const common = {
        email: placeholder,
        phone: null,
        customerNote: null,
        ipAddress: null,
        cartSessionId: null,
        anonymizedAt: now,
      };
      const hasInvoice = (orderIdColumn: typeof orders.id) =>
        sql`EXISTS (SELECT 1 FROM ${invoices} WHERE ${invoices.orderId} = ${orderIdColumn})`;
      // Without invoices nothing binds the buyer data: erase it completely.
      await tx
        .update(orders)
        .set({
          ...common,
          firstName: '',
          lastName: '',
          company: null,
          billingAddress: null,
          internalNote: null,
        })
        .where(and(inArray(orders.id, orderIds), sql`NOT ${hasInvoice(orders.id)}`));
      // With invoices (GoBD): name, company and billing address stay until the retention ends.
      const retained = await tx
        .update(orders)
        .set({
          ...common,
          personalDataRetainedUntil: sql`(
            SELECT (date_trunc('year', max(${invoices.issuedAt}) AT TIME ZONE 'UTC')
                    + make_interval(years => ${1 + invoiceRetentionYears}::int)) AT TIME ZONE 'UTC'
            FROM ${invoices} WHERE ${invoices.orderId} = ${orders.id})`,
        })
        .where(and(inArray(orders.id, orderIds), hasInvoice(orders.id)))
        .returning({ id: orders.id });
      ordersRetained = retained.length;

      // Rendered ticket files: delete only keys that no other ticket still references.
      // Candidates: the keys the tickets pointed at plus the order-level PDF (written per order).
      const keys = [
        ...new Set([
          ...keyRows.flatMap((t) => [t.pdf, t.pkpass]),
          ...orderRows.map((o) =>
            orderTicketsObjectKey(String(o.createdAt.getUTCFullYear()), o.orderNumber),
          ),
        ]),
      ].filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        const stillUsed = await tx
          .select({ pdf: tickets.pdfObjectKey, pkpass: tickets.pkpassObjectKey })
          .from(tickets)
          .where(or(inArray(tickets.pdfObjectKey, keys), inArray(tickets.pkpassObjectKey, keys)));
        const used = new Set(stillUsed.flatMap((r) => [r.pdf, r.pkpass]));
        storageKeys.push(...keys.filter((k) => !used.has(k)));
      }
    }

    // ── The customer record ──
    await tx
      .update(customers)
      .set({
        email: placeholder,
        firstName: '',
        lastName: '',
        company: null,
        phone: null,
        address: null,
        locale: null,
        marketingConsentAt: null,
        passwordHash: null,
        accountCreatedAt: null,
        emailVerifiedAt: null,
        lastLoginAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        anonymizedAt: now,
      })
      .where(eq(customers.id, customerId));
    await tx.delete(customerSessions).where(eq(customerSessions.customerId, customerId));
    await tx.delete(customerTokens).where(eq(customerTokens.customerId, customerId));

    const summary: AnonymizationResult = {
      alreadyAnonymized: false,
      orders: orderIds.length,
      ordersRetained,
      emails: mails.length,
      tickets: ticketCount,
      refunds: refundCount,
      webhooks: webhookCount,
      history: historyCount,
    };
    // Erasure ledger (outside `public`, survives restores; no personal data).
    await tx.insert(erasures).values({ customerId, scope: 'CUSTOMER' }).onConflictDoNothing();
    if (!replay)
      await writeCustomerAudit(tx, actor!, 'customer.anonymize', customerId, { ...summary });
    return { ...summary, storageKeys };
  });

  // Best effort after the commit: a storage outage must not undo the erasure.
  for (const key of result.storageKeys) {
    try {
      await ctx.storage?.delete('documents', key);
    } catch (err) {
      console.error('[privacy] could not delete stored ticket file', err);
    }
  }
  const { storageKeys: _keys, ...summary } = result;
  return summary;
}

/** Envelope that replaces the stored e-mail request: variables gone, message not re-sendable. */
const PURGED_ENVELOPE = sql`CASE WHEN jsonb_typeof(${emailMessages.attachments}) = 'object'
  THEN (${emailMessages.attachments} - 'variables' - 'customerId')
       || jsonb_build_object('purgedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  ELSE jsonb_build_object(
    'v', 1,
    'attachments', CASE WHEN jsonb_typeof(${emailMessages.attachments}) = 'array'
                        THEN ${emailMessages.attachments} ELSE '[]'::jsonb END,
    'locale', null, 'eventId', null, 'customerId', null, 'variables', null,
    'purgedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) END`;

// ─── Retention job ────────────────────────────────────────────────────────────────────

export interface PrivacyRetentionResult {
  emailsPurged: number;
  ordersErased: number;
  webhooksScrubbed: number;
}

/**
 * Daily housekeeping (worker):
 * 1. e-mail log: stored variables, error texts and rendered subjects of delivered / failed
 *    messages older than `privacy.emailRetentionDays` are erased (0 = keep);
 * 2. payment webhooks older than `privacy.webhookRetentionDays`: payer / name / e-mail / address
 *    fields are erased (ids, type, amounts, status stay; at most 1000 per run);
 * 3. orders of anonymised customers whose invoice retention has ended: name, company, billing
 *    address and notes are erased. Invoices themselves are immutable and never touched.
 */
export async function runPrivacyRetention(
  ctx: Pick<CoreContext, 'db'>,
): Promise<PrivacyRetentionResult> {
  const settings = await getSetting(ctx, 'privacy');
  let emailsPurged = 0;
  if (settings.emailRetentionDays > 0) {
    const purged = await ctx.db
      .update(emailMessages)
      .set({
        subject: sql`CASE WHEN ${emailMessages.templateKey} IS NULL THEN ${emailMessages.subject}
          ELSE '[' || ${emailMessages.templateKey}::text || ']' END`,
        lastError: null,
        attachments: PURGED_ENVELOPE,
      })
      .where(
        and(
          inArray(emailMessages.status, ['SENT', 'FAILED']),
          sql`${emailMessages.createdAt} < now() - make_interval(days => ${settings.emailRetentionDays}::int)`,
          sql`NOT coalesce(${emailMessages.attachments} ? 'purgedAt', false)`,
        ),
      )
      .returning({ id: emailMessages.id });
    emailsPurged = purged.length;
  }

  const erased = await ctx.db
    .update(orders)
    .set({
      firstName: '',
      lastName: '',
      company: null,
      billingAddress: null,
      internalNote: null,
      personalDataRetainedUntil: null,
    })
    .where(
      and(
        isNotNull(orders.personalDataRetainedUntil),
        sql`${orders.personalDataRetainedUntil} <= now()`,
        // Only erase for customers that asked for it (anonymised), never on a stray date.
        isNotNull(orders.anonymizedAt),
        // A later invoice / credit note of the order extends the retention.
        notExists(
          ctx.db
            .select({ x: sql`1` })
            .from(invoices)
            .where(
              and(
                eq(invoices.orderId, orders.id),
                sql`(date_trunc('year', ${invoices.issuedAt} AT TIME ZONE 'UTC')
                  + make_interval(years => ${1 + settings.invoiceRetentionYears}::int)) AT TIME ZONE 'UTC' > now()`,
              ),
            ),
        ),
      ),
    )
    .returning({ id: orders.id });

  let webhooksScrubbed = 0;
  if (settings.webhookRetentionDays > 0) {
    const old = await ctx.db
      .select({ id: webhookEvents.id, payload: webhookEvents.payload })
      .from(webhookEvents)
      .where(
        and(
          sql`${webhookEvents.receivedAt} < now() - make_interval(days => ${settings.webhookRetentionDays}::int)`,
          sql`NOT (${webhookEvents.payload} ? ${WEBHOOK_MARKER})`,
        ),
      )
      .limit(1_000);
    webhooksScrubbed = await scrubWebhookRows(ctx.db, old);
  }
  return { emailsPurged, ordersErased: erased.length, webhooksScrubbed };
}

/**
 * After a restore: re-applies every recorded erasure (the ledger survives restores) so
 * anonymised customers do not reappear with their personal data. Idempotent; customers that do
 * not exist in the restored data are skipped.
 */
export async function replayErasureLedger(
  ctx: CoreContext,
): Promise<{ replayed: number; skipped: number }> {
  const rows = await ctx.db.select({ customerId: erasures.customerId }).from(erasures);
  let replayed = 0;
  let skipped = 0;
  for (const { customerId } of rows) {
    try {
      const result = await anonymizeCustomer(ctx, null, customerId, { replay: true });
      if (result.alreadyAnonymized) skipped += 1;
      else replayed += 1;
    } catch (err) {
      if (err instanceof DomainError && err.code === 'CUSTOMER_NOT_FOUND') skipped += 1;
      else throw err;
    }
  }
  return { replayed, skipped };
}
