import { TICKET_DESIGN_FILE_MAX_BYTES, defaultTicketLayout } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import { DomainError, parseTicketDesignFile } from '../src';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function validFile(overrides: Record<string, unknown> = {}) {
  return {
    format: 'tix-ticket-design',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: { appVersion: 'test' },
    template: {
      name: 'Design',
      description: null,
      pageWidthMm: 150,
      pageHeightMm: 80,
      layout: defaultTicketLayout(),
    },
    images: [],
    background: null,
    ...overrides,
  };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof DomainError ? err.code : 'OTHER';
  }
  return undefined;
};

const parse = (value: unknown) => parseTicketDesignFile(JSON.stringify(value));

describe('parseTicketDesignFile', () => {
  it('accepts a valid file', () => {
    expect(parse(validFile()).template.name).toBe('Design');
  });

  it('rejects non-JSON, foreign formats and unknown versions', () => {
    expect(code(() => parseTicketDesignFile('not json'))).toBe('TICKET_DESIGN_FILE_INVALID');
    expect(code(() => parseTicketDesignFile('null'))).toBe('TICKET_DESIGN_FILE_INVALID');
    expect(code(() => parse(validFile({ format: 'tix-seatmap' })))).toBe(
      'TICKET_DESIGN_FILE_INVALID',
    );
    expect(code(() => parse(validFile({ version: 2 })))).toBe('TICKET_DESIGN_VERSION_UNSUPPORTED');
    expect(code(() => parse(validFile({ version: '1' })))).toBe(
      'TICKET_DESIGN_VERSION_UNSUPPORTED',
    );
  });

  it('rejects oversized files', () => {
    expect(
      code(() => parseTicketDesignFile(new Uint8Array(TICKET_DESIGN_FILE_MAX_BYTES + 1))),
    ).toBe('TICKET_DESIGN_FILE_TOO_LARGE');
  });

  it('rejects out-of-range geometry and unknown image references', () => {
    const bad = (mutate: (f: ReturnType<typeof validFile>) => void) => {
      const f = validFile();
      mutate(f);
      return code(() => parse(f));
    };
    expect(bad((f) => (f.template.pageWidthMm = 99_999))).toBe('TICKET_DESIGN_FILE_INVALID');
    expect(bad((f) => (f.template.layout.qr.size = 1))).toBe('TICKET_DESIGN_FILE_INVALID');
    expect(
      bad((f) =>
        f.template.layout.elements.push({
          kind: 'image',
          id: 'x',
          imageKey: 'missing',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        } as never),
      ),
    ).toBe('TICKET_DESIGN_FILE_INVALID');
  });

  it('rejects unsupported image types, duplicate keys and too many elements', () => {
    const img = { fileName: 'a.png', contentType: 'image/png', dataBase64: PNG_1X1 };
    expect(
      code(() => parse(validFile({ background: { ...img, contentType: 'image/svg+xml' } }))),
    ).toBe('TICKET_DESIGN_FILE_INVALID');
    expect(
      code(() =>
        parse(
          validFile({
            images: [
              { key: 'a', ...img },
              { key: 'a', ...img },
            ],
          }),
        ),
      ),
    ).toBe('TICKET_DESIGN_FILE_INVALID');
    const many = validFile();
    many.template.layout.elements = Array.from({ length: 201 }, (_, i) => ({
      kind: 'shape',
      id: `s${i}`,
      shape: 'rect',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })) as never;
    expect(code(() => parse(many))).toBe('TICKET_DESIGN_FILE_INVALID');
  });
});
