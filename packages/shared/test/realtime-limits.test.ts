import { describe, expect, it } from 'vitest';
import { ConnectionCounter, TokenBucket, installFloodGuard, setBounded } from '../src/realtime-limits';

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const b = new TokenBucket(5, 2, 0);
    for (let i = 0; i < 5; i += 1) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
  });
  it('refills over time but never above capacity', () => {
    const b = new TokenBucket(5, 2, 0);
    for (let i = 0; i < 5; i += 1) b.take(0);
    expect(b.take(500)).toBe(true); // +1 token
    expect(b.take(500)).toBe(false);
    for (let i = 0; i < 5; i += 1) expect(b.take(60_000)).toBe(true);
    expect(b.take(60_000)).toBe(false);
  });
});

describe('ConnectionCounter', () => {
  it('caps per key and frees slots on release', () => {
    const c = new ConnectionCounter(2);
    expect(c.acquire('a')).toBe(true);
    expect(c.acquire('a')).toBe(true);
    expect(c.acquire('a')).toBe(false);
    expect(c.acquire('b')).toBe(true);
    c.release('a');
    expect(c.acquire('a')).toBe(true);
    c.release('a');
    c.release('a');
    c.release('b');
    expect(c.size).toBe(0);
  });
});

describe('setBounded', () => {
  it('refuses new keys beyond max but updates existing ones', () => {
    const m = new Map<string, number>();
    expect(setBounded(m, 'a', 1, 2)).toBe(true);
    expect(setBounded(m, 'b', 1, 2)).toBe(true);
    expect(setBounded(m, 'c', 1, 2)).toBe(false);
    expect(setBounded(m, 'a', 2, 2)).toBe(true);
    expect(m.get('a')).toBe(2);
    expect(m.size).toBe(2);
  });
});

describe('installFloodGuard', () => {
  const fakeSocket = () => {
    let handler: ((packet: unknown[], next: (err?: Error) => void) => void) | null = null;
    const state = { disconnects: 0, errors: 0, passed: 0 };
    const socket = {
      use: (fn: NonNullable<typeof handler>) => void (handler = fn),
      disconnect: () => void (state.disconnects += 1),
    };
    const send = () =>
      handler!(['evt'], (err) => {
        if (err) state.errors += 1;
        else state.passed += 1;
      });
    return { socket, state, send };
  };

  it('passes packets within budget and disconnects a flooder without ever raising an error', () => {
    const { socket, state, send } = fakeSocket();
    installFloodGuard(socket, new TokenBucket(3, 1, 0));
    for (let i = 0; i < 50; i += 1) send();
    expect(state.passed).toBe(3);
    expect(state.disconnects).toBe(1);
    expect(state.errors).toBe(0);
  });
});
