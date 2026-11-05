import { BUILTIN_SYMBOLS } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import { DomainError, sanitizeSvg } from '../src';

const wrap = (inner: string, attrs = 'viewBox="0 0 24 24"') =>
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('SVG sanitizer', () => {
  it('keeps shapes and geometry, removes scripts, handlers and external references', () => {
    const dirty = wrap(
      `<script>alert(1)</script>
       <style>*{fill:url(https://evil.example/x)}</style>
       <a href="javascript:alert(1)"><path d="M0 0L10 10" onclick="alert(1)" fill="#ff0000"/></a>
       <image href="https://evil.example/x.png" width="10" height="10"/>
       <use href="#x"/>
       <foreignObject><div>html</div></foreignObject>
       <circle cx="12" cy="12" r="4" style="fill:red" fill="url(#g)" stroke="blue"/>`,
    );
    const { markup, viewBox } = sanitizeSvg(dirty, false);
    expect(viewBox).toBe('0 0 24 24');
    expect(markup).toContain('<path d="M0 0L10 10" fill="#ff0000"');
    expect(markup).toContain('<circle cx="12" cy="12" r="4" stroke="blue"');
    for (const bad of [
      'script',
      'alert',
      'style',
      'href',
      'image',
      'use',
      'foreignObject',
      'url(',
      'onclick',
      'html',
    ]) {
      expect(markup).not.toContain(bad);
    }
  });

  it('colourises paint with currentColor but keeps fill="none"', () => {
    const { markup } = sanitizeSvg(
      wrap(
        '<path d="M1 1h5" fill="#123456" stroke="none"/><rect x="1" y="1" width="2" height="2" stroke="red"/>',
      ),
      true,
    );
    expect(markup).toContain('fill="currentColor" stroke="none"');
    expect(markup).toContain('stroke="currentColor"');
  });

  it('derives the viewBox from width/height and rejects non-SVG or empty input', () => {
    expect(
      sanitizeSvg(wrap('<rect width="5" height="5"/>', 'width="40px" height="20"'), false).viewBox,
    ).toBe('0 0 40 20');
    expect(() => sanitizeSvg('<html><body>no svg</body></html>', false)).toThrow(DomainError);
    expect(() => sanitizeSvg(wrap('<script>x()</script>'), false)).toThrow(/no drawable shapes/);
  });

  it('accepts every built-in symbol', () => {
    for (const symbol of BUILTIN_SYMBOLS) {
      const result = sanitizeSvg(wrap(symbol.markup, `viewBox="${symbol.viewBox}"`), true);
      expect(result.markup.length, symbol.key).toBeGreaterThan(20);
    }
  });
});
