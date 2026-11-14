import {
  bankAccounts,
  customers,
  invoices,
  orderAdjustments,
  orderItems,
  tickets,
  type Executor,
} from '@tix/db';
import { foregroundOn, type PaymentMethod } from '@tix/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { CoreContext } from '../context';
import {
  describeOrderItem,
  documentItems,
  loadOrderDocumentData,
  type OrderDocumentData,
} from '../documents/order-data';
import { formatDate, formatDateTime, formatIban, formatMoney, formatTime } from '../format';
import { mailTranslator, type MailTranslator } from '../i18n/mail-messages';
import { orderAccessToken, orderUrl } from '../orders/access';
import { getSetting } from '../settings';
import { ticketLinksVariable } from '../tickets/email-links';
import { walletLinksVariable } from '../wallet/links';
import { escapeHtml, trustedHtml, type TemplateVariables } from './template';

/**
 * Standard template variables. Shop/organizer variables are available in every e-mail,
 * order variables whenever the message belongs to an order.
 */
export const EMAIL_VARIABLES = {
  shop: [
    'shopName',
    'shopUrl',
    'supportEmail',
    'brandColor',
    // Black or white, whichever reads better on the brand colour (button / banner text).
    'brandForegroundColor',
    // Aliases of brandColor (the shop has one brand colour); kept so edited templates still render.
    'primaryColor',
    'accentColor',
    'imprintUrl',
    'privacyUrl',
    'termsUrl',
    'organizerName',
    'organizerAddress',
    'organizerEmail',
    'organizerPhone',
    'organizerWebsite',
    'organizerVatId',
    'recipientEmail',
  ],
  customer: ['firstName', 'lastName', 'fullName', 'email'],
  order: [
    'firstName',
    'lastName',
    'fullName',
    'email',
    'company',
    'orderNumber',
    'orderDate',
    'orderStatus',
    'amount',
    'amountPaid',
    'amountDue',
    'currency',
    'paymentMethod',
    'paymentReference',
    'paymentDueDate',
    'autoCancelDate',
    'bankAccountHolder',
    'iban',
    'bic',
    'bankName',
    'orderUrl',
    'eventTitle',
    'eventDate',
    'eventVenue',
    'eventList',
    'itemsTable',
    'ticketCount',
    'reminderCount',
    'cancellationReason',
    'invoiceNumber',
  ],
  /**
   * Passed by the refund flow (REFUND_CONFIRMATION): `refundViaPaypal` / `refundManual` are "yes" or
   * empty – PayPal pays back automatically, everything else is transferred by hand.
   */
  refund: ['refundAmount', 'creditNoteNumber', 'refundViaPaypal', 'refundManual'],
  /**
   * ADDITIONAL_PAYMENT_REQUEST / _REMINDER: the mail only carries the `adjustmentId`; amount,
   * reference and the old / new price table are built when the message is rendered.
   */
  adjustment: [
    'adjustmentAmount',
    // Overpayment credited against the price difference (empty without credit).
    'adjustmentCreditUsed',
    'adjustmentReference',
    'adjustmentReason',
    'adjustmentItems',
    // ADDITIONAL_PAYMENT_RECEIVED only: passed when the payment is booked; the two amounts are
    // formatted at render time from `adjustmentNewTotalCents` / `adjustmentPreviouslyPaidCents`.
    'adjustmentNewTotal',
    'adjustmentPreviouslyPaid',
    'adjustmentOldInvoiceNumber',
    'adjustmentNewInvoiceNumber',
    'adjustmentCreditNoteNumber',
  ],
  /**
   * PAYMENT_RECEIVED_TICKETS / TICKETS_RESENT: `walletLinks` is generated HTML (empty when wallet passes are off),
   * `ticketLinks` one block per valid ticket (single PDF + wallet buttons), `ticketsPdfUrl` the combined tickets PDF
   * download (empty without valid tickets), `ticketsAttached` "yes" when the tickets PDF is attached (set on delivery).
   */
  tickets: ['walletLinks', 'ticketLinks', 'ticketsPdfUrl', 'ticketsAttached'],
  account: ['verificationUrl', 'resetUrl', 'loginUrl', 'inviteUrl', 'expiresAt'],
  smtpTest: ['sentAt'],
} as const;

export interface ShopContext {
  locale: string;
  timeZone: string;
  shopName: string;
}

/** Shop-wide variables (branding, organizer, support contact). */
export async function shopVariables(
  ctx: CoreContext,
  locale: string,
): Promise<{ variables: TemplateVariables; shop: ShopContext }> {
  const [general, branding, organizer] = await Promise.all([
    getSetting(ctx, 'general'),
    getSetting(ctx, 'branding'),
    getSetting(ctx, 'organizer'),
  ]);
  const address = [
    organizer.street,
    [organizer.postalCode, organizer.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');
  return {
    shop: { locale, timeZone: general.defaultTimeZone, shopName: general.shopName },
    variables: {
      shopName: general.shopName,
      shopUrl: ctx.appUrl ? `${ctx.appUrl}/${locale}` : null,
      supportEmail: general.supportEmail ?? organizer.email ?? null,
      brandColor: branding.brandColor,
      brandForegroundColor: foregroundOn(branding.brandColor),
      primaryColor: branding.brandColor,
      accentColor: branding.brandColor,
      imprintUrl: branding.imprintUrl ?? null,
      privacyUrl: branding.privacyUrl ?? null,
      termsUrl: branding.termsUrl ?? null,
      organizerName: organizer.legalName ?? general.shopName,
      organizerAddress: address || null,
      organizerEmail: organizer.email ?? null,
      organizerPhone: organizer.phone ?? null,
      organizerWebsite: organizer.website ?? null,
      organizerVatId: organizer.vatId ?? null,
    },
  };
}

export function paymentMethodLabel(method: PaymentMethod, t: MailTranslator): string {
  return t(`paymentMethods.${method}`);
}

/** Variables of an order e-mail (buyer, amounts, Vorkasse terms, events and items). */
export async function orderVariables(
  ctx: CoreContext,
  data: OrderDocumentData,
  shop: ShopContext,
  options: { invoiceIds?: string[] } = {},
): Promise<TemplateVariables> {
  const { order } = data;
  const locale = shop.locale;
  const t = mailTranslator(locale);
  const money = (cents: number) => formatMoney(cents, order.currency, locale);
  const items = documentItems(data);

  const [bank] =
    order.paymentMethod === 'BANK_TRANSFER' || order.paymentReference
      ? await ctx.db
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.isDefaultForBankTransfer, true))
          .limit(1)
      : [];
  const invoiceNumbers = options.invoiceIds?.length
    ? await ctx.db
        .select({ number: invoices.invoiceNumber })
        .from(invoices)
        .where(inArray(invoices.id, options.invoiceIds))
    : [];

  const first = data.events[0];
  return {
    firstName: order.firstName,
    lastName: order.lastName,
    fullName: `${order.firstName} ${order.lastName}`.trim(),
    email: order.email,
    company: order.company,
    orderNumber: order.orderNumber,
    orderDate: formatDate(order.createdAt, locale, shop.timeZone),
    orderStatus: order.status,
    amount: money(order.totalGross),
    amountPaid: money(order.amountPaid),
    amountDue: money(Math.max(order.totalGross - order.amountPaid, 0)),
    currency: order.currency,
    paymentMethod: paymentMethodLabel(order.paymentMethod, t),
    paymentReference: order.paymentReference,
    paymentDueDate: order.paymentDueAt
      ? formatDate(order.paymentDueAt, locale, shop.timeZone)
      : null,
    /** Empty when the order is not cancelled automatically (use `{{#if autoCancelDate}}`). */
    autoCancelDate: order.autoCancelAt
      ? formatDate(order.autoCancelAt, locale, shop.timeZone)
      : null,
    bankAccountHolder: bank?.accountHolder ?? null,
    iban: bank ? formatIban(bank.iban) : null,
    bic: bank?.bic ?? null,
    bankName: bank?.bankName ?? null,
    orderUrl: ctx.appUrl ? orderUrl(ctx, order) : null,
    eventTitle: first?.title ?? null,
    eventDate: first ? formatDateTime(first.startsAt, locale, first.timeZone) : null,
    eventVenue: first ? [first.venueName, first.venueCity].filter(Boolean).join(', ') : null,
    eventList: eventList(data, locale),
    itemsTable: itemsTable(data, items, locale, t),
    ticketCount: items.length,
    reminderCount: order.reminderCount,
    cancellationReason: order.cancellationReason,
    invoiceNumber: invoiceNumbers.map((i) => i.number).join(', ') || null,
    walletLinks: await walletLinksVariable(ctx, order.id, locale),
    ticketLinks: await ticketLinksVariable(ctx, order.id, locale),
    ticketsPdfUrl: await ticketsPdfUrl(ctx, order.id),
  };
}

function eventWhenWhere(event: OrderDocumentData['events'][number], locale: string): string {
  return [
    formatDateTime(event.startsAt, locale, event.timeZone),
    [event.venueName, event.venueCity].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}

function eventList(data: OrderDocumentData, locale: string) {
  const html = data.events
    .map(
      (e) =>
        `<li style="margin:0 0 8px"><strong>${escapeHtml(e.title)}</strong><br><span style="color:#52525b">${escapeHtml(eventWhenWhere(e, locale))}</span></li>`,
    )
    .join('');
  const text = data.events.map((e) => `- ${e.title}\n  ${eventWhenWhere(e, locale)}`).join('\n');
  return trustedHtml(html ? `<ul style="margin:0;padding:0 0 0 18px">${html}</ul>` : '', text);
}

const CELL = 'padding:6px 0;border-top:1px solid #e4e4e7;vertical-align:top';

function itemsTable(
  data: OrderDocumentData,
  items: OrderDocumentData['items'],
  locale: string,
  t: MailTranslator,
) {
  const { order } = data;
  const money = (cents: number) => formatMoney(cents, order.currency, locale);
  const html: string[] = [];
  const text: string[] = [];
  for (const event of data.events) {
    const eventItems = items.filter((i) => i.eventId === event.id);
    if (eventItems.length === 0) continue;
    const doors = event.doorsOpenAt
      ? ` · ${t('items.doorsOpen', { time: formatTime(event.doorsOpenAt, locale, event.timeZone) })}`
      : '';
    html.push(
      `<tr><td colspan="2" style="padding:14px 0 2px;font-weight:600;font-size:15px">${escapeHtml(event.title)}</td></tr>`,
      `<tr><td colspan="2" style="padding:0 0 6px;color:#52525b;font-size:13px">${escapeHtml(eventWhenWhere(event, locale) + doors)}</td></tr>`,
    );
    text.push(event.title, eventWhenWhere(event, locale) + doors);
    for (const item of eventItems) {
      const what = describeOrderItem(item, t);
      const detail = [item.categoryName, item.ticketTypeName].filter(Boolean).join(' · ');
      html.push(
        `<tr><td style="${CELL}">${escapeHtml(what)}<br><span style="color:#52525b;font-size:13px">${escapeHtml(detail)}</span></td><td align="right" style="${CELL};white-space:nowrap">${escapeHtml(money(item.priceGross))}</td></tr>`,
      );
      text.push(`  - ${what} (${detail}): ${money(item.priceGross)}`);
    }
    text.push('');
  }
  const fees = data.fees.filter((f) => f.totalGross > 0);
  if (fees.length > 0) {
    // Subtotal before fees, so subtotal + fees visibly add up to the total.
    const subtotal = order.totalGross - fees.reduce((sum, f) => sum + f.totalGross, 0);
    html.push(
      `<tr><td style="padding:8px 0;border-top:1px solid #a1a1aa;font-weight:600">${escapeHtml(t('items.subtotal'))}</td><td align="right" style="padding:8px 0;border-top:1px solid #a1a1aa;font-weight:600;white-space:nowrap">${escapeHtml(money(subtotal))}</td></tr>`,
      `<tr><td colspan="2" style="padding:14px 0 2px;font-weight:600;font-size:15px">${escapeHtml(t('items.fees'))}</td></tr>`,
    );
    text.push(`${t('items.subtotal')}: ${money(subtotal)}`, '');
    text.push(t('items.fees'));
    for (const fee of fees) {
      const event = fee.eventId ? data.eventById.get(fee.eventId) : undefined;
      const name =
        fee.quantity > 1
          ? t('items.feeQuantity', { name: fee.name, quantity: fee.quantity })
          : fee.name;
      const label = event ? `${name} – ${event.title}` : name;
      html.push(
        `<tr><td style="${CELL}">${escapeHtml(label)}</td><td align="right" style="${CELL};white-space:nowrap">${escapeHtml(money(fee.totalGross))}</td></tr>`,
      );
      text.push(`  - ${label}: ${money(fee.totalGross)}`);
    }
    text.push('');
  }
  html.push(
    `<tr><td style="padding:10px 0;border-top:2px solid #18181b;font-weight:700">${escapeHtml(t('items.total'))}</td><td align="right" style="padding:10px 0;border-top:2px solid #18181b;font-weight:700;white-space:nowrap">${escapeHtml(money(order.totalGross))}</td></tr>`,
  );
  text.push(`${t('items.total')}: ${money(order.totalGross)}`);
  if (
    (order.status === 'PARTIALLY_REFUNDED' || order.status === 'REFUNDED') &&
    order.amountRefunded > 0
  ) {
    const remaining = Math.max(order.totalGross - order.amountRefunded, 0);
    const row = (label: string, value: string) =>
      `<tr><td style="${CELL}">${escapeHtml(label)}</td><td align="right" style="${CELL};white-space:nowrap">${escapeHtml(value)}</td></tr>`;
    html.push(
      row(t('items.refunded'), `−${money(order.amountRefunded)}`),
      row(t('items.remaining'), money(remaining)),
    );
    text.push(
      `${t('items.refunded')}: −${money(order.amountRefunded)}`,
      `${t('items.remaining')}: ${money(remaining)}`,
    );
  }
  return trustedHtml(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:1.45">${html.join('')}</table>`,
    text.join('\n'),
  );
}

/** Customer variables for account e-mails without an order. */
export async function customerVariables(
  db: Executor,
  customerId: string,
): Promise<{ variables: TemplateVariables; email: string; locale: string | null } | null> {
  const [customer] = await db
    .select({
      email: customers.email,
      firstName: customers.firstName,
      lastName: customers.lastName,
      locale: customers.locale,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;
  return {
    email: customer.email,
    locale: customer.locale,
    variables: {
      firstName: customer.firstName,
      lastName: customer.lastName,
      fullName: `${customer.firstName} ${customer.lastName}`.trim(),
      email: customer.email,
    },
  };
}

export { loadOrderDocumentData };

/** Absolute download link of the tickets PDF of an order; null without `appUrl` or valid tickets. */
async function ticketsPdfUrl(ctx: CoreContext, orderId: string): Promise<string | null> {
  if (!ctx.appUrl) return null;
  const [valid] = await ctx.db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.orderId, orderId), eq(tickets.status, 'VALID')))
    .limit(1);
  if (!valid) return null;
  return `${ctx.appUrl}/api/orders/${orderId}/tickets?t=${encodeURIComponent(orderAccessToken(ctx, orderId))}`;
}

/** Variables of ADDITIONAL_PAYMENT_REQUEST / _REMINDER, built from the stored adjustment. */
export async function adjustmentVariables(
  ctx: CoreContext,
  adjustmentId: string,
  currency: string,
  shop: ShopContext,
  /** Mail variables of the message (ADDITIONAL_PAYMENT_RECEIVED passes the booked amounts). */
  extra: TemplateVariables = {},
): Promise<TemplateVariables> {
  const [adjustment] = await ctx.db
    .select()
    .from(orderAdjustments)
    .where(eq(orderAdjustments.id, adjustmentId));
  if (!adjustment) return {};
  const locale = shop.locale;
  const t = mailTranslator(locale);
  const money = (cents: number) => formatMoney(cents, currency, locale);
  // The place of each ticket, so two changed tickets are distinguishable.
  const places = new Map(
    (adjustment.items.length > 0
      ? await ctx.db
          .select({
            id: orderItems.id,
            kind: orderItems.kind,
            sectionLabel: orderItems.sectionLabel,
            rowLabel: orderItems.rowLabel,
            seatLabel: orderItems.seatLabel,
          })
          .from(orderItems)
          .where(
            inArray(
              orderItems.id,
              adjustment.items.map((i) => i.orderItemId),
            ),
          )
      : []
    ).map((r) => [r.id, describeOrderItem(r, t)] as const),
  );
  const rows = adjustment.items.map((item) => ({
    label: [places.get(item.orderItemId), `${item.fromName} → ${item.toName}`]
      .filter(Boolean)
      .join(': '),
    price: `${money(item.fromPriceGross)} → ${money(item.toPriceGross)}`,
  }));
  const html = rows
    .map(
      (r) =>
        `<tr><td style="${CELL}">${escapeHtml(r.label)}</td><td align="right" style="${CELL};white-space:nowrap">${escapeHtml(r.price)}</td></tr>`,
    )
    .join('');
  // With an overpayment credited: difference, credit and the rest still to pay add up visibly.
  const credited = adjustment.creditApplied > 0;
  const difference = adjustment.amount + adjustment.creditApplied;
  const totalLabel = t(credited ? 'items.remainingToPay' : 'items.additionalPayment');
  const creditRows = credited
    ? [
        [t('items.priceDifference'), money(difference)],
        [t('items.creditApplied'), `−${money(adjustment.creditApplied)}`],
      ]
    : [];
  const creditHtml = creditRows
    .map(
      ([label, value]) =>
        `<tr><td style="${CELL}">${escapeHtml(label!)}</td><td align="right" style="${CELL};white-space:nowrap">${escapeHtml(value!)}</td></tr>`,
    )
    .join('');
  const total = `${creditHtml}<tr><td style="padding:10px 0;border-top:2px solid #18181b;font-weight:700">${escapeHtml(totalLabel)}</td><td align="right" style="padding:10px 0;border-top:2px solid #18181b;font-weight:700;white-space:nowrap">${escapeHtml(money(adjustment.amount))}</td></tr>`;
  const cents = (value: unknown) => (typeof value === 'number' ? money(value) : null);
  return {
    adjustmentNewTotal: cents(extra.adjustmentNewTotalCents),
    adjustmentPreviouslyPaid: cents(extra.adjustmentPreviouslyPaidCents),
    adjustmentAmount: money(adjustment.amount),
    adjustmentCreditUsed: credited ? money(adjustment.creditApplied) : null,
    adjustmentReference: adjustment.paymentReference,
    adjustmentReason: adjustment.reason,
    adjustmentItems: trustedHtml(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:1.45">${html}${total}</table>`,
      [
        ...rows.map((r) => `  - ${r.label}: ${r.price}`),
        ...creditRows.map(([label, value]) => `${label}: ${value}`),
        `${totalLabel}: ${money(adjustment.amount)}`,
      ].join('\n'),
    ),
  };
}
