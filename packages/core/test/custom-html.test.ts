import { describe, expect, it } from 'vitest';
import { sanitizeCustomHtml } from '../src/custom-html';

describe('sanitizeCustomHtml', () => {
  it('removes scripts, frames, plugins, forms and head elements', () => {
    const out = sanitizeCustomHtml(
      '<div>a</div><script>alert(1)</script><iframe src="https://x.example">fb</iframe>' +
        '<object data="x"></object><embed src="x"><form action="/x"><input name="a"><textarea>t</textarea></form>' +
        '<base href="https://evil.example"><meta http-equiv="refresh" content="0"><link rel="stylesheet" href="x">',
    );
    expect(out).not.toMatch(
      /script|iframe|object|embed|<form|<input|textarea|<base|<meta|<link|alert|fb/,
    );
    expect(out).toContain('<div>a</div>');
  });

  it('removes event handlers and script-capable URLs', () => {
    const out = sanitizeCustomHtml(
      '<img src="https://x.example/a.png" onerror="alert(1)" onclick="x()">' +
        '<a href="javascript:alert(1)">j</a><a href="vbscript:x">v</a><a href="data:text/html,x">d</a>' +
        '<a href="https://ok.example">ok</a><a href="/events">rel</a>',
    );
    expect(out).not.toMatch(/onerror|onclick|javascript|vbscript|data:text/);
    expect(out).toContain('href="https://ok.example"');
    expect(out).toContain('href="/events"');
  });

  it('keeps style elements and style attributes but drops CSS imports', () => {
    const out = sanitizeCustomHtml(
      '<style>.tix-start-custom h1{color:red}</style><p style="color:blue;margin:0">x</p>' +
        '<style>@import url(https://evil.example/a.css); p{color:red}</style>',
    );
    expect(out).toContain('<style>.tix-start-custom h1{color:red}</style>');
    expect(out).toContain('style="color:blue;margin:0"');
    expect(out).not.toContain('@import');
  });

  it('adds rel to target=_blank links', () => {
    const out = sanitizeCustomHtml(
      '<a href="https://x.example" target="_blank" rel="opener">x</a>',
    );
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('allows data:image in img only', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeCustomHtml(`<img src="${png}" alt="">`)).toContain(png);
    expect(sanitizeCustomHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')).not.toContain(
      'data:',
    );
    expect(
      sanitizeCustomHtml('<video src="data:video/mp4;base64,AAAA" controls></video>'),
    ).not.toContain('data:');
  });

  it('keeps layout, media and data attributes; buttons never submit; autoplay needs muted', () => {
    const out = sanitizeCustomHtml(
      '<section class="a" id="b" data-x="1" aria-label="l"><picture><source srcset="/api/media/1 1x"><img src="/api/media/1" alt="" loading="lazy"></picture>' +
        '<video controls autoplay src="/api/media/2"></video><video muted autoplay loop src="/api/media/2"></video>' +
        '<button type="submit" onclick="x()">go</button></section>',
    );
    expect(out).toContain('data-x="1"');
    expect(out).toContain('aria-label="l"');
    expect(out).toContain('srcset="/api/media/1 1x"');
    expect(out).toContain('<button type="button">go</button>');
    expect(out.match(/autoplay/g)).toHaveLength(1);
  });

  it('returns an empty string for empty input', () => {
    expect(sanitizeCustomHtml(undefined)).toBe('');
    expect(sanitizeCustomHtml('')).toBe('');
  });
});
