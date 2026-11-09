/** Per-event inputs of the Vorkasse auto-cancel rule. */
export interface CancelTermEvent {
  /** Own number of days (null = use the global value). */
  bankTransferCancelAfterDays: number | null;
  /** FALSE = auto-cancel disabled for this event; NULL = enabled / inherited. */
  bankTransferAutoCancel: boolean | null;
}

/**
 * Days until an unpaid Vorkasse order is cancelled automatically, or `null` = never.
 *
 * Per event: disabled (flag false) → no deadline; otherwise own days ?? global days (the global
 * value may be null = no automatic cancellation). A multi-event order uses the strictest rule –
 * the shortest deadline among the events that have auto-cancel enabled. Events without
 * auto-cancel never shorten it; if none has it enabled the order is not cancelled automatically.
 * The result is never shorter than the payment term.
 */
export function resolveCancelDays(
  events: readonly CancelTermEvent[],
  globalCancelDays: number | null,
  termDays: number,
): number | null {
  const days = events
    .filter((e) => e.bankTransferAutoCancel !== false)
    .map((e) => e.bankTransferCancelAfterDays ?? globalCancelDays)
    .filter((d): d is number => d !== null);
  return days.length > 0 ? Math.max(termDays, Math.min(...days)) : null;
}
