import { describe, expect, it } from 'vitest';
import { parseCancelPaidForm } from '../src/refund-form';

const ID_A = '0b0a1c0e-5d3e-4c8f-9a52-1f2f3a4b5c6d';
const ID_B = '7f3c2a10-1b2c-4d3e-8f90-a1b2c3d4e5f6';

function form(entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe('parseCancelPaidForm', () => {
  it('parses a complete submission and deduplicates items', () => {
    const result = parseCancelPaidForm(
      form([
        ['orderItemIds', ID_A],
        ['orderItemIds', ID_B],
        ['orderItemIds', ID_A],
        ['refundFees', 'on'],
        ['notify', 'on'],
        ['confirmed', 'on'],
        ['reason', '  Show cancelled  '],
        ['expectedVersion', '4'],
      ]),
    );
    expect(result).toEqual({
      orderItemIds: [ID_A, ID_B],
      refundFees: true,
      notify: true,
      confirmed: true,
      reason: 'Show cancelled',
      expectedVersion: 4,
    });
  });

  it('treats unchecked boxes as false and an empty reason as null', () => {
    const result = parseCancelPaidForm(
      form([
        ['orderItemIds', ID_A],
        ['confirmed', 'on'],
        ['reason', ' '],
      ]),
    );
    expect(result).toMatchObject({
      refundFees: false,
      notify: false,
      reason: null,
      expectedVersion: undefined,
    });
  });

  it('rejects missing confirmation, no items and malformed ids', () => {
    expect(parseCancelPaidForm(form([['orderItemIds', ID_A]]))).toBeNull();
    expect(parseCancelPaidForm(form([['confirmed', 'on']]))).toBeNull();
    expect(
      parseCancelPaidForm(
        form([
          ['orderItemIds', 'nope'],
          ['confirmed', 'on'],
        ]),
      ),
    ).toBeNull();
  });
});
