import { describe, expect, it } from 'vitest';
import {
  buildPairingUri,
  decideScan,
  normalizePairingCode,
  parsePairingUri,
  scanColor,
  scanRequestSchema,
  type DecisionInput,
  type DecisionTicket,
} from '../src';

const ticket = (over: Partial<DecisionTicket> = {}): DecisionTicket => ({
  status: 'VALID',
  checkInState: 'NONE',
  requiresProof: false,
  seatFeature: null,
  additionalPaymentOpen: false,
  entranceId: null,
  ...over,
});
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  action: 'CHECK_IN',
  ticket: ticket(),
  deviceEntranceId: null,
  checkOutAllowed: true,
  ...over,
});

describe('decideScan', () => {
  it('accepts a plain valid ticket (green)', () => {
    const d = decideScan(input());
    expect(d).toEqual({ result: 'ACCEPTED', warnings: [], nextState: 'CHECKED_IN' });
    expect(scanColor(d.result)).toBe('GREEN');
  });

  it('collects every warning but still admits (yellow)', () => {
    const d = decideScan(
      input({
        ticket: ticket({
          requiresProof: true,
          seatFeature: 'WHEELCHAIR_SPACE',
          additionalPaymentOpen: true,
          entranceId: 'north',
        }),
        deviceEntranceId: 'south',
      }),
    );
    expect(d.result).toBe('ACCEPTED_WITH_WARNING');
    expect(d.nextState).toBe('CHECKED_IN');
    expect(d.warnings).toEqual([
      'DISCOUNT_PROOF_REQUIRED',
      'WRONG_ENTRANCE',
      'SEAT_FEATURE',
      'ADDITIONAL_PAYMENT_OPEN',
    ]);
    expect(scanColor(d.result)).toBe('YELLOW');
  });

  it('warns about the entrance only when both sides are known and differ', () => {
    const w = (device: string | null, own: string | null) =>
      decideScan(input({ ticket: ticket({ entranceId: own }), deviceEntranceId: device })).warnings;
    expect(w(null, 'a')).toEqual([]);
    expect(w('a', null)).toEqual([]);
    expect(w('a', 'a')).toEqual([]);
    expect(w('a', 'b')).toEqual(['WRONG_ENTRANCE']);
  });

  it('allows re-entry after a check-out', () => {
    expect(decideScan(input({ ticket: ticket({ checkInState: 'CHECKED_OUT' }) })).result).toBe(
      'ACCEPTED',
    );
  });

  it('rejects a second check-in without changing state (red)', () => {
    const d = decideScan(input({ ticket: ticket({ checkInState: 'CHECKED_IN' }) }));
    expect(d).toEqual({ result: 'REJECTED_ALREADY_CHECKED_IN', warnings: [], nextState: null });
    expect(scanColor(d.result)).toBe('RED');
  });

  it.each(['CANCELLED', 'REFUNDED', 'REPLACED'] as const)(
    'rejects a %s ticket as void',
    (status) => {
      expect(decideScan(input({ ticket: ticket({ status }) })).result).toBe('REJECTED_TICKET_VOID');
      expect(decideScan(input({ ticket: ticket({ status }), action: 'CHECK_OUT' })).result).toBe(
        'REJECTED_TICKET_VOID',
      );
    },
  );

  it('rejects an unknown ticket', () => {
    expect(decideScan(input({ ticket: null })).result).toBe('REJECTED_UNKNOWN_TICKET');
  });

  it('check-out needs permission and a checked-in ticket', () => {
    const out = (over: Partial<DecisionInput>) =>
      decideScan(input({ action: 'CHECK_OUT', ...over }));
    expect(out({ ticket: ticket({ checkInState: 'CHECKED_IN' }) })).toEqual({
      result: 'ACCEPTED',
      warnings: [],
      nextState: 'CHECKED_OUT',
    });
    expect(
      out({ ticket: ticket({ checkInState: 'CHECKED_IN' }), checkOutAllowed: false }).result,
    ).toBe('REJECTED_CHECK_OUT_NOT_ALLOWED');
    expect(out({}).result).toBe('REJECTED_NOT_CHECKED_IN');
    expect(out({ ticket: ticket({ checkInState: 'CHECKED_OUT' }) }).result).toBe(
      'REJECTED_NOT_CHECKED_IN',
    );
  });
});

describe('decideScan: stale scans (late offline uploads)', () => {
  const stale = (over: Partial<DecisionInput>) => decideScan(input({ stale: true, ...over }));
  const inside = ticket({ checkInState: 'CHECKED_IN' });
  const outside = ticket({ checkInState: 'CHECKED_OUT' });

  it('never changes the state', () => {
    for (const t of [ticket(), inside, outside]) {
      for (const action of ['CHECK_IN', 'CHECK_OUT'] as const) {
        for (const before of [true, false]) {
          expect(
            stale({ ticket: t, action, scannedBeforeFirstEntry: before }).nextState,
          ).toBeNull();
        }
      }
    }
  });

  it('a historic check-in counts only when older than the first entry', () => {
    expect(stale({ ticket: outside, scannedBeforeFirstEntry: false }).result).toBe(
      'REJECTED_ALREADY_CHECKED_IN',
    );
    const earlier = stale({
      ticket: ticket({ checkInState: 'CHECKED_IN', requiresProof: true }),
      scannedBeforeFirstEntry: true,
      exitBetween: true,
    });
    expect(earlier.result).toBe('ACCEPTED_WITH_WARNING');
    expect(earlier.warnings).toEqual(['DISCOUNT_PROOF_REQUIRED']);
  });

  it('a stale check-in older than the first entry without a check-out in between is a duplicate', () => {
    expect(
      stale({ ticket: inside, scannedBeforeFirstEntry: true, exitBetween: false }).result,
    ).toBe('REJECTED_ALREADY_CHECKED_IN');
  });

  it('a historic check-out is valid when the guest had entered before it', () => {
    expect(
      stale({ ticket: inside, action: 'CHECK_OUT', scannedBeforeFirstEntry: false }).result,
    ).toBe('ACCEPTED');
    expect(
      stale({ ticket: inside, action: 'CHECK_OUT', scannedBeforeFirstEntry: true }).result,
    ).toBe('REJECTED_NOT_CHECKED_IN');
    expect(stale({ ticket: inside, action: 'CHECK_OUT', checkOutAllowed: false }).result).toBe(
      'REJECTED_CHECK_OUT_NOT_ALLOWED',
    );
  });

  it('void tickets stay void', () => {
    expect(stale({ ticket: ticket({ status: 'CANCELLED' }) }).result).toBe('REJECTED_TICKET_VOID');
  });
});

describe('pairing helpers', () => {
  it('normalises typed codes', () => {
    expect(normalizePairingCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizePairingCode('o1l-I0')).toBe('01110');
  });

  it('round-trips the QR uri', () => {
    const uri = buildPairingUri('http://192.168.1.20:8080/', 'abcde-fghjk');
    expect(uri).toBe('tixscan://pair?v=1&u=http%3A%2F%2F192.168.1.20%3A8080&c=ABCDEFGHJK');
    expect(parsePairingUri(uri)).toEqual({
      serverUrl: 'http://192.168.1.20:8080',
      code: 'ABCDEFGHJK',
    });
    expect(parsePairingUri('https://example.org')).toBeNull();
    expect(parsePairingUri('tixscan://pair?v=2&u=x&c=ABCDEFGHJK')).toBeNull();
  });
});

describe('scan request schema', () => {
  const base = {
    clientScanId: '3b0c9d9c-5f0a-4d50-9a5b-0e1f2a3b4c5d',
    eventId: '4b0c9d9c-5f0a-4d50-9a5b-0e1f2a3b4c5d',
    action: 'CHECK_IN',
    source: 'CAMERA',
    scannedAt: '2026-11-10T18:00:00+01:00',
  };
  it('requires exactly one ticket identifier', () => {
    expect(scanRequestSchema.safeParse({ ...base, payload: 'tix://v1/x' }).success).toBe(true);
    expect(scanRequestSchema.safeParse(base).success).toBe(false);
    expect(
      scanRequestSchema.safeParse({ ...base, payload: 'x', ticketCode: 'ABCDEFGHJK' }).success,
    ).toBe(false);
  });
});
