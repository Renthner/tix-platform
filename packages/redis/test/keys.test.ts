import { describe, expect, it } from 'vitest';
import { createChannels, createKeyspace } from '../src/keys';

describe('redis keyspace', () => {
  const keys = createKeyspace('tix');
  const eventId = '0196f3c2-1a2b-7c3d-8e4f-001122334455';

  it('co-locates all keys of one event in the same cluster slot (hash tag)', () => {
    const tag = `{ev:${eventId}}`;
    for (const key of [
      keys.seatLock(eventId, 'seat-1'),
      keys.cartSeats(eventId, 'sess-1'),
      keys.seatLockExpiries(eventId),
      keys.queueWaiting(eventId),
      keys.queuePass(eventId, 'sess-1'),
    ]) {
      expect(key.startsWith(`tix:${tag}:`)).toBe(true);
    }
  });

  it('builds the seat lock key from event and seat id', () => {
    expect(keys.seatLock(eventId, 'abc')).toBe(`tix:{ev:${eventId}}:seat:abc`);
  });

  it('keeps the multi-event cart outside any event slot', () => {
    expect(keys.cart('sess-1')).toBe('tix:cart:sess-1');
  });

  it('rejects unsafe segments (no key injection via user input)', () => {
    expect(() => keys.seatLock(eventId, 'a b')).toThrow();
    expect(() => keys.queuePass(eventId, '}{ev:other}')).toThrow();
    expect(() => createKeyspace('bad prefix')).toThrow();
  });

  it('builds pub/sub channels', () => {
    expect(createChannels('tix').seatUpdates(eventId)).toBe(`tix:ch:ev:${eventId}:seats`);
  });
});
