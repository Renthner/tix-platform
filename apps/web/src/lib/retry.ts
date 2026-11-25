/** Delay before automatic retry number `attempt` (0-based): 2 s, 4 s, 8 s … capped at 30 s, ±20 % jitter. */
export function retryDelayMs(attempt: number): number {
  const base = Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
