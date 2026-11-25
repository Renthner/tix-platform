/**
 * GiroCode (EPC QR) in bank-transfer e-mails: the `{{paymentQrCode}}` block, its inline PNG (decoded
 * back with jsQR) and the admin preview / default templates.
 */
import { inflateSync } from 'node:zlib';
import { defaultEmailTemplates } from '@tix/db';
import { emailTemplateVariables } from '@tix/shared';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_QR_CID,
  buildPaymentQr,
  inlineAttachments,
  inlineImagesAsDataUris,
  renderTemplateDraft,
  sampleEmailVariables,
  samplePaymentQr,
} from '../src';
import { buildEpcPayload } from '../src/payments/epc-qr';
import { epcQrPng } from '../src/payments/qr-png';

const input = {
  holder: 'Example Club e.V.',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  amountCents: 4_800,
  currency: 'EUR',
  reference: 'TIX-2026-123456-7',
};

/** Decodes the 1-bit greyscale PNG written by `moduleMatrixPng` into RGBA pixels. */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8ClampedArray } {
  const buf = Buffer.from(png);
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9]]).toEqual([1, 0]); // bit depth 1, greyscale
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = Math.ceil(width / 8);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (rowBytes + 1)]).toBe(0); // filter: none
    for (let x = 0; x < width; x++) {
      const byte = raw[y * (rowBytes + 1) + 1 + (x >> 3)]!;
      const value = byte & (0x80 >> (x & 7)) ? 255 : 0;
      rgba.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

describe('epcQrPng', () => {
  it('writes a valid PNG whose QR code decodes to the EPC payload', () => {
    const payload = buildEpcPayload({ ...input, name: input.holder })!;
    const png = decodePng(epcQrPng(payload));
    expect(png.width).toBe(png.height);
    expect(jsQR(png.rgba, png.width, png.height)?.data).toBe(payload);
  });
});

describe('buildPaymentQr', () => {
  it('builds the block and the inline image for an EUR transfer with a reference', () => {
    const qr = buildPaymentQr(input, 'de')!;
    expect(qr.image).toMatchObject({
      cid: PAYMENT_QR_CID,
      fileName: 'girocode.png',
      contentType: 'image/png',
    });
    expect(qr.variable.html).toContain(`<img src="cid:${PAYMENT_QR_CID}"`);
    expect(qr.variable.html).toContain('width="180"');
    expect(qr.variable.html).toContain('Mit deiner Banking-App scannen');
    expect(buildPaymentQr(input, 'en')!.variable.html).toContain('Scan with your banking app');
    // Nothing for the plain-text part (the bank details are listed there).
    expect(qr.variable.text).toBe('');
  });

  it('is null without reference, outside EUR, with nothing due or an invalid IBAN', () => {
    expect(buildPaymentQr({ ...input, reference: null }, 'en')).toBeNull();
    expect(buildPaymentQr({ ...input, reference: '' }, 'en')).toBeNull();
    expect(buildPaymentQr({ ...input, currency: 'CHF' }, 'en')).toBeNull();
    expect(buildPaymentQr({ ...input, amountCents: 0 }, 'en')).toBeNull();
    expect(buildPaymentQr({ ...input, iban: 'DE00123' }, 'en')).toBeNull();
  });

  it('becomes a nodemailer inline attachment with a Content-ID', () => {
    const qr = buildPaymentQr(input, 'en')!;
    expect(inlineAttachments([qr.image])).toEqual([
      expect.objectContaining({
        cid: PAYMENT_QR_CID,
        filename: 'girocode.png',
        contentType: 'image/png',
        contentDisposition: 'inline',
      }),
    ]);
  });
});

describe('{{paymentQrCode}} in templates', () => {
  it('is offered only for the bank-transfer confirmation and the payment reminder', () => {
    const has = (key: Parameters<typeof emailTemplateVariables>[0]) =>
      emailTemplateVariables(key).some((v) => v.name === 'paymentQrCode' && v.kind === 'html');
    expect(has('ORDER_CONFIRMATION_BANK_TRANSFER')).toBe(true);
    expect(has('PAYMENT_REMINDER')).toBe(true);
    expect(has('ADDITIONAL_PAYMENT_REQUEST')).toBe(false);
    expect(has('PAYMENT_RECEIVED_TICKETS')).toBe(false);
  });

  it('sits right after the bank details in the four defaults (HTML only)', () => {
    const slots = defaultEmailTemplates().filter((t) => t.bodyHtml.includes('{{paymentQrCode}}'));
    expect(slots.map((t) => `${t.key}|${t.locale}`).sort()).toEqual([
      'ORDER_CONFIRMATION_BANK_TRANSFER|de',
      'ORDER_CONFIRMATION_BANK_TRANSFER|en',
      'PAYMENT_REMINDER|de',
      'PAYMENT_REMINDER|en',
    ]);
    for (const t of slots) {
      expect(t.bodyHtml).toMatch(
        /<\/table>\{\{else\}\}[\s\S]*?\{\{\/if\}\}\n\{\{paymentQrCode\}\}\n/,
      );
      expect(t.bodyText).not.toContain('paymentQrCode');
    }
  });

  it('renders the sample GiroCode in previews and nothing when the value is empty', () => {
    const draft = {
      subject: 'S',
      bodyHtml: '<p>a</p>\n{{paymentQrCode}}\n<p>b</p>',
      bodyText: null,
    };
    const vars = sampleEmailVariables('ORDER_CONFIRMATION_BANK_TRANSFER', 'en', {});
    const rendered = renderTemplateDraft(draft, vars);
    expect(rendered.html).toContain(`cid:${PAYMENT_QR_CID}`);
    const preview = inlineImagesAsDataUris(rendered.html, [samplePaymentQr('en')!.image]);
    expect(preview).not.toContain('cid:');
    expect(preview).toContain('src="data:image/png;base64,');

    const empty = renderTemplateDraft(draft, { ...vars, paymentQrCode: null });
    expect(empty.html).toBe('<p>a</p>\n\n<p>b</p>');
    expect(empty.missing).toEqual([]);
  });
});
