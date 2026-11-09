import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  buildTicketPayload,
  bytesToUuid,
  normalizeTicketCode,
  parseTicketPayload,
  ticketSeatInfo,
  verifyTicketPayload,
} from '../src';
import { ed25519Signer, generateEd25519KeyMaterial, publicKeyFromSeed } from '../src/server';

/** Fixed vector (also in docs/TICKETS.md): seed = bytes 0x00..0x1f. Ed25519 is deterministic. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const VECTOR = {
  publicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  fields: {
    keyId: 'k1',
    eventId: '00000000-0000-4000-8000-000000000001',
    ticketId: '00000000-0000-4000-8000-000000000002',
    seatInfo: 'Parkett|R5|12',
  },
  signingInput: 'tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg.UGFya2V0dHxSNXwxMg',
  payload:
    'tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg.UGFya2V0dHxSNXwxMg.rtTDrMv6GaEmTIQMvUPkOC7LGLnEOSzp816oE6eIZdLaTuccet2SFH1H-UxDjs-uXuucamvw30cb6SeM4bMkBA',
};

const EVENT = VECTOR.fields.eventId;
const resolver = (publicKey: string) => () => publicKey;

describe('ticket QR payload (tix v1)', () => {
  it('reproduces the fixed test vector', async () => {
    expect(publicKeyFromSeed(SEED)).toBe(VECTOR.publicKey);
    const payload = await buildTicketPayload(VECTOR.fields, ed25519Signer(SEED));
    expect(payload.startsWith(`${VECTOR.signingInput}.`)).toBe(true);
    expect(payload).toBe(VECTOR.payload);
    const verified = await verifyTicketPayload(VECTOR.payload, EVENT, resolver(VECTOR.publicKey));
    expect(verified).toEqual({ ok: true, ticket: VECTOR.fields });
  });

  it('round-trips parse', () => {
    const parsed = parseTicketPayload(VECTOR.payload)!;
    expect(parsed).toMatchObject(VECTOR.fields);
    expect(parsed.signingInput).toBe(VECTOR.signingInput);
    expect(parsed.signature).toHaveLength(64);
  });

  it('detects tampering of every segment', async () => {
    const parts = VECTOR.payload.slice('tix://v1/'.length).split('.');
    const mutate = (i: number, value: string) =>
      'tix://v1/' + parts.map((p, j) => (j === i ? value : p)).join('.');
    const other = await buildTicketPayload(
      {
        ...VECTOR.fields,
        ticketId: '00000000-0000-4000-8000-000000000003',
        seatInfo: 'Parkett|R5|13',
      },
      ed25519Signer(SEED),
    );
    const otherParts = other.slice('tix://v1/'.length).split('.');
    const keyOk = resolver(VECTOR.publicKey);
    // event, ticket, seat info swapped in from a different (validly signed) ticket
    for (const i of [2, 3]) {
      const res = await verifyTicketPayload(mutate(i, otherParts[i]!), EVENT, keyOk);
      expect(res).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    }
    const seat = base64urlEncode(new TextEncoder().encode('Parkett|R5|13'));
    expect(await verifyTicketPayload(mutate(3, seat), EVENT, keyOk)).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
    // Tampered event segment: the ticket now claims another event than the verifier's.
    const forgedEvent = mutate(1, base64urlEncode(new Uint8Array(16).fill(1)));
    expect(await verifyTicketPayload(forgedEvent, EVENT, keyOk)).toEqual({
      ok: false,
      reason: 'WRONG_EVENT',
    });
    expect(
      await verifyTicketPayload(forgedEvent, bytesToUuid(new Uint8Array(16).fill(1)), keyOk),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    const flipped = parts[4]!.startsWith('A') ? 'B' : 'A';
    expect(
      await verifyTicketPayload(mutate(4, flipped + parts[4]!.slice(1)), EVENT, keyOk),
    ).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects a wrong key and unknown keys', async () => {
    const wrong = generateEd25519KeyMaterial();
    expect(await verifyTicketPayload(VECTOR.payload, EVENT, resolver(wrong.publicKey))).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
    expect(await verifyTicketPayload(VECTOR.payload, EVENT, () => null)).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
    expect(await verifyTicketPayload(VECTOR.payload, EVENT, () => 'AAAA')).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
  });

  it('selects the verification key by key id (retired key still verifies)', async () => {
    const oldKey = generateEd25519KeyMaterial();
    const newKey = generateEd25519KeyMaterial();
    const fields = { ...VECTOR.fields, keyId: 'oldKey01' };
    const payload = await buildTicketPayload(
      fields,
      ed25519Signer(Buffer.from(oldKey.seed, 'base64url')),
    );
    const keys: Record<string, string> = { oldKey01: oldKey.publicKey, newKey02: newKey.publicKey };
    const res = await verifyTicketPayload(payload, EVENT, (_event, keyId) => keys[keyId]);
    expect(res.ok).toBe(true);
    delete keys.oldKey01; // revoked → resolver returns nothing
    expect(await verifyTicketPayload(payload, EVENT, (_e, k) => keys[k])).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
  });

  it('handles seat info with dots, pipes and unicode', async () => {
    const seatInfo = ticketSeatInfo({
      kind: 'SEAT',
      sectionLabel: 'Balkon 1.0 | links',
      rowLabel: 'Reihe ä.1',
      seatLabel: '12 ♿',
      showSectionLabel: true,
    });
    expect(seatInfo).toBe('Balkon 1.0 / links|Reihe ä.1|12 ♿');
    const payload = await buildTicketPayload({ ...VECTOR.fields, seatInfo }, ed25519Signer(SEED));
    expect(payload.slice('tix://v1/'.length).split('.')).toHaveLength(5);
    const res = await verifyTicketPayload(payload, EVENT, resolver(VECTOR.publicKey));
    expect(res).toMatchObject({ ok: true, ticket: { seatInfo } });
  });

  it('respects show_label_on_ticket and general admission', () => {
    expect(
      ticketSeatInfo({
        kind: 'SEAT',
        sectionLabel: 'Secret',
        rowLabel: '3',
        seatLabel: '4',
        showSectionLabel: false,
      }),
    ).toBe('|3|4');
    expect(
      ticketSeatInfo({
        kind: 'GENERAL_ADMISSION',
        sectionLabel: 'Stehplatz',
        showSectionLabel: true,
      }),
    ).toBe('GA:Stehplatz');
  });

  it('truncates long seat info without splitting characters', () => {
    const long = ticketSeatInfo({
      kind: 'GENERAL_ADMISSION',
      sectionLabel: 'ä'.repeat(100),
      showSectionLabel: true,
    });
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(80);
    expect(long.endsWith('ä')).toBe(true);
  });

  it('rejects malformed payloads', async () => {
    const bad = [
      '',
      'tix://v2/' + VECTOR.payload.slice(9),
      VECTOR.payload + '.x',
      VECTOR.payload.replace('k1.', '.'),
      VECTOR.payload.slice(0, -1),
      VECTOR.payload.replace('UGFya2V0dHxSNXwxMg', 'UGFya2V0dHxSNXwxMh'), // non-canonical bits
    ];
    for (const p of bad) {
      expect(parseTicketPayload(p), p).toBeNull();
      expect(await verifyTicketPayload(p, EVENT, resolver(VECTOR.publicKey))).toEqual({
        ok: false,
        reason: 'MALFORMED',
      });
    }
  });

  it('rejects a ticket of another event before any key lookup', async () => {
    let lookups = 0;
    const res = await verifyTicketPayload(
      VECTOR.payload,
      '00000000-0000-4000-8000-0000000000ff',
      () => {
        lookups += 1;
        return VECTOR.publicKey;
      },
    );
    expect(res).toEqual({ ok: false, reason: 'WRONG_EVENT' });
    expect(lookups).toBe(0);
  });

  it('normalises ticket codes with Crockford aliases', () => {
    expect(normalizeTicketCode('abcde-fgh1o')).toBe('ABCDEFGH10');
    expect(normalizeTicketCode(' il 0o ')).toBe('1100');
  });

  it('base64url decoder is strict', () => {
    expect(base64urlDecode('AQID')).toEqual(Uint8Array.of(1, 2, 3));
    expect(base64urlDecode('AQID=')).toBeNull();
    expect(base64urlDecode('A+ID')).toBeNull();
    expect(base64urlDecode('A')).toBeNull();
  });
});
