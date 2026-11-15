// Entry point kept for existing imports; the implementation lives in ./fees/*.
export { EventFeesManager } from './fees/event-fees';
export { FeesAdmin } from './fees/global-fees';
export type {
  EventGlobalFeeView,
  EventOwnFeeView,
  FeeView,
  GlobalFeeRowView,
  TaxRateOption,
  TaxRateRowView,
} from './fees/types';
