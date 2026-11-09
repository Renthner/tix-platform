import { randomBytes } from 'node:crypto';
import { EMAIL_CONTENT_END, EMAIL_CONTENT_START } from '@tix/shared';
import sanitizeHtml from 'sanitize-html';

/**
 * Allow-list sanitiser for e-mail template HTML saved in the Admin Portal.
 *
 * E-mail needs table layouts and inline styles, so the allow-list is wider than the one for
 * web rich text – but still without scripts, forms, frames, `<style>`/`<link>`, event
 * handlers, CSS `url()` and `javascript:` / `data:` links. `{{placeholders}}` are protected
 * (swapped for inert tokens while sanitising) so they survive inside attributes and style
 * values; the default templates pass through unchanged.
 */

const TAGS = [
  'html',
  'head',
  'meta',
  'title',
  'body',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'div',
  'p',
  'br',
  'hr',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'code',
  'pre',
  'mark',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'img',
];

const STYLE_PROPERTIES = [
  'color',
  'background',
  'background-color',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-style',
  'border-width',
  'border-radius',
  'border-collapse',
  'border-spacing',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'text-transform',
  'text-indent',
  'vertical-align',
  'white-space',
  'word-break',
  'word-wrap',
  'overflow-wrap',
  'display',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'list-style-type',
  '-webkit-text-size-adjust',
];

/** Plain CSS values only: no url(), expressions, imports, escapes, markup or `;` smuggling. */
const SAFE_STYLE_VALUE =
  /^(?!.*(?:url\s*\(|expression|javascript|@import|behavior|-moz-binding|\\))[\w\s#%.,()'"!+\-*/]*$/i;

const STYLE_RULES = Object.fromEntries(STYLE_PROPERTIES.map((p) => [p, [SAFE_STYLE_VALUE]]));

const ROLE = /^(presentation|none|article|banner|contentinfo|main|region)$/;

const LINK_TARGET = /^(https?:\/\/|mailto:|tel:)/i;
const IMAGE_SOURCE = /^https:\/\//i;

const PLACEHOLDER = /\{\{[^{}]*\}\}/g;

export interface SanitizeEmailOptions {
  /** Origin that turns app-relative `/api/media/…` image URLs into absolute ones. */
  baseUrl?: string | null;
}

/** Longest accepted document (characters). */
export const EMAIL_HTML_MAX_LENGTH = 200_000;

/** Sanitises an e-mail body (full document or fragment). Placeholders are preserved. */
export function sanitizeEmailHtml(input: string, options: SanitizeEmailOptions = {}): string {
  const source = input.slice(0, EMAIL_HTML_MAX_LENGTH);
  const nonce = randomBytes(6).toString('hex');
  const tokens: string[] = [];
  const tokenRe = new RegExp(`tixph${nonce}x(\\d+)x`, 'g');
  const protectedSource = source
    .replace(PLACEHOLDER, (match) => {
      tokens.push(match);
      return `tixph${nonce}x${tokens.length - 1}x`;
    })
    // Comments are dropped by the sanitiser; the content markers travel as inert text tokens.
    .replace(EMAIL_CONTENT_START, `tixmarker${nonce}start`)
    .replace(EMAIL_CONTENT_END, `tixmarker${nonce}end`);

  const hasDoctype = /^\s*<!doctype\s+html/i.test(source);
  let clean = sanitizeHtml(protectedSource, {
    allowedTags: TAGS,
    allowedAttributes: {
      '*': ['style', 'role', 'lang', 'dir', 'title'],
      html: ['lang', 'dir'],
      meta: ['charset', 'name', 'content'],
      a: ['href', 'target', 'rel', 'title', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      table: ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor', 'role', 'style'],
      td: ['align', 'valign', 'colspan', 'rowspan', 'width', 'height', 'bgcolor', 'style'],
      th: ['align', 'valign', 'colspan', 'rowspan', 'width', 'height', 'bgcolor', 'style'],
      tr: ['align', 'valign', 'style'],
    },
    allowedStyles: { '*': STYLE_RULES },
    // URL schemes are checked in transformTags (placeholders stand in for URLs).
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    allowedSchemesAppliedToAttributes: [],
    disallowedTagsMode: 'discard',
    transformTags: {
      '*': (tagName, attribs) => {
        const next = { ...attribs };
        if (next.role !== undefined && !ROLE.test(next.role)) delete next.role;
        return { tagName, attribs: next };
      },
      a: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        const href = (next.href ?? '').trim();
        if (href && isSafeHref(href, nonce)) {
          next.href = href;
          next.rel = 'noopener noreferrer';
        } else {
          delete next.href;
        }
        return { tagName, attribs: next };
      },
      img: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        let src = (next.src ?? '').trim();
        if (src.startsWith('/api/media/') && options.baseUrl) {
          src = `${options.baseUrl.replace(/\/+$/, '')}${src}`;
        }
        if (isSafeImage(src, nonce, options.baseUrl)) next.src = src;
        else delete next.src;
        return { tagName, attribs: next };
      },
    },
    // Images without a (valid) source carry no information.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });

  clean = clean
    .replace(new RegExp(`tixmarker${nonce}start`, 'g'), EMAIL_CONTENT_START)
    .replace(new RegExp(`tixmarker${nonce}end`, 'g'), EMAIL_CONTENT_END)
    .replace(tokenRe, (_m, index: string) => tokens[Number(index)] ?? '');
  // The sanitiser drops the doctype directive; documents keep theirs.
  if (hasDoctype) clean = `<!DOCTYPE html>\n${clean.trimStart()}`;
  return clean.trim();
}

/** Link target: http(s), mailto, tel – or a single placeholder (optionally after `mailto:`). */
function isSafeHref(href: string, nonce: string): boolean {
  if (LINK_TARGET.test(href)) return true;
  return new RegExp(`^(mailto:|tel:)?(tixph${nonce}x\\d+x)+$`).test(href);
}

function isSafeImage(src: string, nonce: string, baseUrl?: string | null): boolean {
  if (IMAGE_SOURCE.test(src)) return true;
  if (new RegExp(`^(tixph${nonce}x\\d+x)+$`).test(src)) return true;
  // Absolute media URL of this installation over plain http (local setups).
  return Boolean(baseUrl) && src.startsWith(`${baseUrl!.replace(/\/+$/, '')}/api/media/`);
}
