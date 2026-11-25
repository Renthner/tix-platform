import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';
import {
  buildEpcPayload,
  epcAmount,
  epcQrBytes,
  epcQrData,
  epcQrSvg,
} from '../src/payments/epc-qr';

const base = {
  name: 'Example Club e.V.',
  iban: 'DE89 3704 0044 0532 0130 00',
  bic: 'COBADEFFXXX',
  amountCents: 12_345,
  reference: 'TIX-2026-123456-7',
};

describe('epcAmount', () => {
  it('formats cents without rounding errors', () => {
    expect(epcAmount(1)).toBe('0.01');
    expect(epcAmount(100)).toBe('1.00');
    expect(epcAmount(12_345)).toBe('123.45');
    expect(epcAmount(99_999_999_999)).toBe('999999999.99');
  });
});

describe('buildEpcPayload', () => {
  it('builds version 002 (UTF-8, SCT) and ends with the last populated element', () => {
    const payload = buildEpcPayload(base)!;
    expect(payload.split('\n')).toEqual([
      'BCD',
      '002',
      '1',
      'SCT',
      'COBADEFFXXX',
      'Example Club e.V.',
      'DE89370400440532013000',
      'EUR123.45',
      '',
      '',
      'TIX-2026-123456-7',
    ]);
    expect(payload.endsWith('\n')).toBe(false);
  });

  it('rejects an empty reference', () => {
    expect(buildEpcPayload({ ...base, reference: '' })).toBeNull();
    expect(buildEpcPayload({ ...base, reference: ' \n ' })).toBeNull();
  });

  it('allows a missing BIC', () => {
    expect(buildEpcPayload({ ...base, bic: null })!.split('\n')[4]).toBe('');
  });

  it('cuts the reference to 140 characters and the name to 70', () => {
    const lines = buildEpcPayload({
      ...base,
      reference: 'x'.repeat(200),
      name: 'n'.repeat(100),
    })!.split('\n');
    expect(lines[10]).toHaveLength(140);
    expect(lines[5]).toHaveLength(70);
  });

  it('removes line breaks from free text', () => {
    const lines = buildEpcPayload({ ...base, reference: 'a\nb\r\nc' })!.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe('a b c');
  });

  it('rejects an invalid IBAN', () => {
    expect(buildEpcPayload({ ...base, iban: 'DE89 3704 0044 0532 0130 01' })).toBeNull();
    expect(buildEpcPayload({ ...base, iban: 'not an iban' })).toBeNull();
    expect(buildEpcPayload({ ...base, iban: '' })).toBeNull();
  });

  it('rejects unusable amounts, currencies, names and BICs', () => {
    expect(buildEpcPayload({ ...base, amountCents: 0 })).toBeNull();
    expect(buildEpcPayload({ ...base, amountCents: -5 })).toBeNull();
    expect(buildEpcPayload({ ...base, amountCents: 10.5 })).toBeNull();
    expect(buildEpcPayload({ ...base, amountCents: 100_000_000_000 })).toBeNull();
    expect(buildEpcPayload({ ...base, currency: 'CHF' })).toBeNull();
    expect(buildEpcPayload({ ...base, name: '  ' })).toBeNull();
    expect(buildEpcPayload({ ...base, bic: 'BAD' })).toBeNull();
  });

  it('stays within 331 bytes or yields null', () => {
    const payload = buildEpcPayload({ ...base, name: 'ä'.repeat(70), reference: 'ö'.repeat(140) });
    // 70 + 140 two-byte characters exceed the limit.
    expect(payload).toBeNull();
  });
});

describe('epcQrBytes / epcQrData', () => {
  it('encodes non-ASCII names as UTF-8 bytes', () => {
    const payload = buildEpcPayload({ ...base, name: 'Müller Bühne' })!;
    const bytes = [...epcQrBytes(payload)];
    // "ü" = U+00FC → C3 BC in UTF-8 (a Latin-1 encoder would write the single byte FC).
    const nameBytes = [...new TextEncoder().encode('Müller Bühne')];
    const offset = new TextEncoder().encode(payload.slice(0, payload.indexOf('Müller'))).length;
    expect(bytes.slice(offset, offset + nameBytes.length)).toEqual(nameBytes);
    expect(nameBytes.slice(1, 3)).toEqual([0xc3, 0xbc]);
    expect(bytes).not.toContain(0xfc);
  });

  it('hands qrcode-generator exactly the UTF-8 bytes in byte mode', () => {
    const payload = buildEpcPayload({ ...base, name: 'Müller Bühne', reference: 'Straße ✓' })!;
    // The library's byte mode turns each character into `charCode & 0xff`.
    expect([...epcQrData(payload)].map((c) => c.charCodeAt(0) & 0xff)).toEqual([
      ...epcQrBytes(payload),
    ]);
    expect([...qrcode.stringToBytes(epcQrData(payload))]).toEqual([...epcQrBytes(payload)]);
  });

  it('measures the 331-byte limit in UTF-8 bytes', () => {
    // 273 bytes as ASCII; the same character count with a two-byte name needs 343 bytes.
    expect(
      buildEpcPayload({ ...base, name: 'a'.repeat(70), reference: 'o'.repeat(140) }),
    ).not.toBeNull();
    expect(
      buildEpcPayload({ ...base, name: 'ä'.repeat(70), reference: 'o'.repeat(140) }),
    ).toBeNull();
  });
});

describe('epcQrSvg', () => {
  it('renders a standalone svg', () => {
    const svg = epcQrSvg(buildEpcPayload(base)!);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('<path d="M');
  });

  it('renders a payload with umlauts', () => {
    expect(epcQrSvg(buildEpcPayload({ ...base, name: 'Müller Bühne' })!)).toContain('<path d="M');
  });
});
