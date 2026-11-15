/**
 * Realtime epoch (client resync logic, pure).
 *
 * The gateway announces an opaque epoch token (`realtime:epoch`) right after every connection and
 * whenever it changes. The token is rotated when the Redis mirror of the seat state is replaced
 * (backup restore: locks and carts are wiped, the database is older). A client that saw a
 * different epoch before must drop its view (locks, availability) and refetch everything,
 * regardless of whether it noticed the maintenance window itself (sleeping laptop, long outage).
 */

export interface EpochObservation {
  /** Epoch to remember from now on. */
  known: string;
  /** A different epoch was known before: the local seat state is stale. */
  changed: boolean;
}

/** Compares an announced epoch with the last known one. The first epoch ever seen is no change. */
export function observeEpoch(known: string | null, incoming: unknown): EpochObservation | null {
  if (typeof incoming !== 'string' || incoming.length === 0 || incoming.length > 128) return null;
  return { known: incoming, changed: known !== null && known !== incoming };
}

/**
 * A full resync was just triggered by the reconnect itself: an epoch change announced right after
 * it must not trigger a second one.
 */
export function shouldRunFullResync(
  now: number,
  lastFullResyncAt: number | null,
  windowMs = 5_000,
): boolean {
  return lastFullResyncAt === null || now - lastFullResyncAt >= windowMs;
}

/** Random delay in [0, spreadMs) – spreads reconnects/polls of many clients (`random` injectable). */
export function spreadDelayMs(spreadMs: number, random: () => number = Math.random): number {
  return Math.floor(Math.max(0, spreadMs) * Math.min(Math.max(random(), 0), 0.999999));
}
