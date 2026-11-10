import type { SettingValue } from '@tix/shared';
import { addPaymentDays, endOfDayInZone } from '@tix/shared';
import { resolveCancelDays, type CancelTermEvent } from './cancel-terms';

export interface TermEvent extends CancelTermEvent {
  startsAt: Date;
  bankTransferPaymentTermDays: number | null;
  bankTransferReminderAfterDays: number | null;
}

export interface BankTransferTerms {
  paymentDueAt: Date;
  nextReminderAt: Date | null;
  autoCancelAt: Date | null;
}

/**
 * Vorkasse deadlines counted from `now`: event override ?? global value, the strictest value of a
 * multi-event order, business days / holidays per the bank-transfer settings, capped at the
 * first event start. Shared by checkout and the reversal of a bank allocation (order awaits
 * payment again).
 */
export function computeBankTransferTerms(params: {
  bank: SettingValue<'bankTransfer'>;
  timeZone: string;
  events: readonly TermEvent[];
  now: Date;
}): BankTransferTerms {
  const { bank, timeZone, events, now } = params;
  const firstEventStart = Math.min(...events.map((e) => e.startsAt.getTime()));
  const strictest = (pick: (e: TermEvent) => number | null, global: number) =>
    Math.min(...events.map((e) => pick(e) ?? global));
  const termDays = strictest((e) => e.bankTransferPaymentTermDays, bank.paymentTermDays);
  const reminderDays = strictest((e) => e.bankTransferReminderAfterDays, bank.reminderAfterDays);
  const cancelDays = resolveCancelDays(events, bank.cancelAfterDays, termDays);
  const capAtEvent = (d: Date) => new Date(Math.min(d.getTime(), firstEventStart));
  const dayOptions = {
    businessDaysOnly: bank.countBusinessDaysOnly,
    state: bank.holidayRegion,
    timeZone,
  };
  const paymentDueAt = capAtEvent(
    endOfDayInZone(addPaymentDays(now, termDays, dayOptions), timeZone),
  );
  const autoCancelAt =
    cancelDays !== null
      ? capAtEvent(endOfDayInZone(addPaymentDays(now, cancelDays, dayOptions), timeZone))
      : null;
  // Reminder on the morning after day X (end of day X + 9 h ≈ 09:00 local time). It must fall
  // before the auto-cancel (if any) or, without auto-cancel, before the event starts.
  const reminder = new Date(
    endOfDayInZone(addPaymentDays(now, reminderDays, dayOptions), timeZone).getTime() +
      9 * 3600_000,
  );
  const nextReminderAt = reminder < (autoCancelAt ?? new Date(firstEventStart)) ? reminder : null;
  return { paymentDueAt, nextReminderAt, autoCancelAt };
}
