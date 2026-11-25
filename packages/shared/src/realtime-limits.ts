/**
 * Pure abuse limiters for the realtime gateway (kept here so they are unit-testable).
 */

/** Token bucket: `capacity` events burst, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Takes one token; false when the bucket is empty (caller should drop / disconnect). */
  take(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.perSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts concurrent connections per key (sid / IP) against a cap. */
export class ConnectionCounter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Registers a connection; false (and nothing registered) when the key is at its cap. */
  acquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.max) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }

  get size(): number {
    return this.counts.size;
  }
}

/** Sets `key` in a bounded map; returns false (without inserting) for a new key beyond `max`. */
export function setBounded<V>(map: Map<string, V>, key: string, value: V, max: number): boolean {
  if (!map.has(key) && map.size >= max) return false;
  map.set(key, value);
  return true;
}

/** The part of a socket.io server socket the flood guard needs (structural, for tests). */
export interface GuardableSocket {
  use(fn: (packet: unknown[], next: (err?: Error) => void) => void): unknown;
  disconnect(close?: boolean): unknown;
}

/**
 * Installs the per-socket event budget. A flooding client is disconnected and its packets are
 * dropped silently: `next` is deliberately never called with an error afterwards, because
 * socket.io turns that into an `error` event on the server socket, which without a listener is an
 * uncaught exception (and would take the whole gateway down).
 */
export function installFloodGuard(
  socket: GuardableSocket,
  bucket: TokenBucket,
  onFlood?: () => void,
): void {
  let flooded = false;
  socket.use((_packet, next) => {
    if (flooded) return;
    if (bucket.take()) return next();
    flooded = true;
    onFlood?.();
    socket.disconnect(true);
  });
}
