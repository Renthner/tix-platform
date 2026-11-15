import type { FeeCalculation, FeeScope, PaymentMethod, SalesChannel } from '@tix/shared';
import type { FeeActionState } from '@/server/admin/fees';

export type Action = (state: FeeActionState, fd: FormData) => Promise<FeeActionState>;

export interface TaxRateOption {
  id: string;
  name: string;
  rateBasisPoints: number;
  isActive: boolean;
}

export interface TaxRateRowView extends TaxRateOption {
  invoiceNote: string | null;
  isDefault: boolean;
  sortOrder: number;
  eventCount: number;
  feeCount: number;
  save: Action;
  remove: Action;
}

export interface FeeView {
  id: string;
  name: string;
  scope: FeeScope;
  calculation: FeeCalculation;
  value: number;
  taxRateId: string | null;
  paymentMethods: PaymentMethod[] | null;
  channels: SalesChannel[] | null;
  isActive: boolean;
  sortOrder: number;
}

export interface GlobalFeeRowView extends FeeView {
  overrideCount: number;
  waivedCount: number;
  save: Action;
  remove: Action;
}

export interface EventGlobalFeeView {
  global: FeeView;
  override: FeeView | null;
  state: 'INHERITED' | 'OVERRIDDEN' | 'WAIVED';
  effective: FeeView;
  charged: boolean;
  adjust: Action;
  waive: Action;
  reset: Action;
}

export interface EventOwnFeeView extends FeeView {
  save: Action;
  remove: Action;
}
