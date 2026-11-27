import type { OrderAdminView, OrderView } from './queries';

/**
 * Presentation model shared by the shop order page and the admin order detail. Pure: both pages feed
 * an order view and get back plain data. Only whitelisted fields are copied, so the shop model can
 * never carry admin-only data (internal notes, payer/bank data of payments, audit history, e-mails)
 * even when it is accidentally fed an admin view.
 */
export type OrderAudience = 'shop' | 'admin';

type OrderItemStatus = OrderView['events'][number]['items'][number]['status'];

export interface OrderItemLine {
  id: string;
  kind: 'SEAT' | 'GENERAL_ADMISSION';
  status: OrderItemStatus;
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  categoryName: string;
  ticketTypeName: string;
  /** Shown price (shop: incl. the code discount share, admin: as booked). */
  price: number;
  /** Admin only: list price shown struck through when a tariff discount applies. */
  strikePrice: number | null;
  /** Cancelled / refunded: rendered struck through. */
  struck: boolean;
  refunded: boolean;
}

export interface OrderFeeLine {
  id: string;
  name: string;
  quantity: number;
  totalGross: number;
}

export interface OrderEventModel {
  eventId: string;
  title: string;
  startsAt: string;
  timeZone: string;
  venueName: string;
  /** Admission-only event (contingents, no seating plan). */
  admission: boolean;
  items: OrderItemLine[];
  /** Fees attached to this event (shop lists them below the event's items). */
  fees: OrderFeeLine[];
}

export interface OrderTotalsModel {
  /** Shop: discount codes line (null when no code discount). */
  discount: { codes: string; amount: number } | null;
  /** Fees listed in the totals block (shop: order-level fees, admin: all fees). */
  fees: OrderFeeLine[];
  total: number;
  taxes: { rateBasisPoints: number; net: number; tax: number }[];
  /** Shop: only when > 0. */
  paid: number | null;
  refunded: number | null;
}

export interface OrderInvoiceLine {
  id: string;
  kind: 'invoice' | 'creditNote' | 'correction';
  number: string;
  correctsNumber: string | null;
  issuedAt: string;
  href: string;
}

export interface BankDetailsModel {
  holder: string;
  iban: string;
  bic: string | null;
  bankName: string | null;
}

export interface OrderViewModel {
  audience: OrderAudience;
  events: OrderEventModel[];
  totals: OrderTotalsModel;
  invoices: OrderInvoiceLine[];
  /** Receiving account for Vorkasse instructions (shop only; the admin never shows it here). */
  bank: BankDetailsModel | null;
}

export interface BuildOrderViewModelOptions {
  audience: OrderAudience;
  /** Shop: `?t=<token>` (or empty) appended to the document links. */
  tokenQuery?: string;
}

const feeLine = (fee: OrderView['fees'][number]): OrderFeeLine => ({
  id: fee.id,
  name: fee.name,
  quantity: fee.quantity,
  totalGross: fee.totalGross,
});

export function buildOrderViewModel(
  view: OrderView | OrderAdminView,
  options: BuildOrderViewModelOptions,
): OrderViewModel {
  const { audience } = options;
  const shop = audience === 'shop';
  const tokenQuery = options.tokenQuery ?? '';
  const { order } = view;

  const events: OrderEventModel[] = view.events.map((event) => ({
    eventId: event.eventId,
    title: event.title,
    startsAt: event.startsAt,
    timeZone: event.timeZone,
    venueName: event.venueName,
    admission: event.admission,
    items: event.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      sectionLabel: item.sectionLabel,
      rowLabel: item.rowLabel,
      seatLabel: item.seatLabel,
      categoryName: item.categoryName,
      ticketTypeName: item.ticketTypeName,
      price: shop ? item.priceGross + item.codeDiscountAmount : item.priceGross,
      strikePrice: !shop && item.discountAmount > 0 ? item.unitPriceGross : null,
      struck: item.status === 'CANCELLED' || item.status === 'REFUNDED',
      refunded: item.status === 'REFUNDED',
    })),
    fees: shop ? view.fees.filter((fee) => fee.eventId === event.eventId).map(feeLine) : [],
  }));

  const totals: OrderTotalsModel = shop
    ? {
        discount:
          order.codeDiscountTotal > 0
            ? {
                codes: view.discounts.map((d) => d.code).join(', '),
                amount: order.codeDiscountTotal,
              }
            : null,
        fees: view.fees.filter((fee) => fee.eventId === null).map(feeLine),
        total: order.totalGross,
        taxes: view.taxes.filter((tax) => tax.rateBasisPoints > 0 && tax.tax > 0),
        paid: order.amountPaid > 0 ? order.amountPaid : null,
        refunded: order.amountRefunded > 0 ? order.amountRefunded : null,
      }
    : {
        discount: null,
        fees: view.fees.map(feeLine),
        total: order.totalGross,
        taxes: view.taxes.map((tax) => ({ ...tax })),
        paid: null,
        refunded: null,
      };

  const invoices: OrderInvoiceLine[] = view.invoices.map((invoice) => ({
    id: invoice.id,
    kind:
      invoice.isCorrection && invoice.correctsNumber
        ? 'correction'
        : invoice.type === 'CREDIT_NOTE'
          ? 'creditNote'
          : 'invoice',
    number: invoice.invoiceNumber,
    correctsNumber: invoice.correctsNumber,
    issuedAt: invoice.issuedAt,
    href: shop
      ? `/api/orders/${order.id}/invoices/${invoice.id}${tokenQuery}`
      : `/api/admin/invoices/${invoice.id}`,
  }));

  const account = view.bankAccount;
  const bank: BankDetailsModel | null =
    shop && account
      ? {
          holder: account.accountHolder,
          iban: account.iban,
          bic: account.bic,
          bankName: account.bankName,
        }
      : null;

  return { audience, events, totals, invoices, bank };
}
