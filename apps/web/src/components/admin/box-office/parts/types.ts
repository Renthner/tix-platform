export interface BoxOfficeEvent {
  id: string;
  title: string;
  startsAt: string;
  timeZone: string;
  venueName: string;
}

export interface Permissions {
  complimentary: boolean;
  priceOverride: boolean;
  blockedSeats: boolean;
}

export type Payment = 'CASH' | 'CARD' | 'COMPLIMENTARY';

export interface Inventory {
  taken: Set<string>;
  locked: Set<string>;
  ga: Record<string, number>;
  version: number;
}

export interface Pick {
  tariffId: string;
  /** Typed price override (text, as entered). */
  override: string;
}

/** What the tab remembers about its selection (the server only knows seats and quantities). */
export interface HoldSnapshot {
  eventId: string;
  picks: [string, Pick][];
  ga: Record<string, Record<string, number>>;
}

export interface Quote {
  currency: string;
  subtotalGross: number;
  discountTotal: number;
  feeTotal: number;
  totalGross: number;
  fees: { name: string; totalGross: number }[];
  buyerDataRequired: boolean;
  smallAmountInvoiceLimit: number;
}

export interface SaleResult {
  orderId: string;
  orderNumber: string;
  totalGross: number;
  currency: string;
  ticketCount: number;
  ticketsReady: boolean;
  payment: Payment;
  email: string | null;
}

export interface BuyerState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  note: string;
  street: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
}

/** What the hold API returns for this tab. */
export interface HeldState {
  seatIds: string[];
  ga: Record<string, number>;
  expiresAt: number | null;
}
