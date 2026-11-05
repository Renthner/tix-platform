import 'server-only';
import sanitizeHtml from 'sanitize-html';

/**
 * Rich text (event descriptions) is produced by the TipTap editor in the Admin Portal and
 * stored as HTML. It is sanitised on save AND on render with the same strict allowlist:
 * formatting, headings, lists, links (http/https/mailto/tel), colours, font family/size and
 * alignment. Scripts, event handlers, iframes, images and arbitrary CSS are removed.
 */

const COLOR = [
  /^#[0-9a-fA-F]{3,8}$/,
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/,
];
const FONT_FAMILY = [/^[\w\s,'"-]{1,120}$/];
const FONT_SIZE = [/^\d{1,3}(\.\d+)?(px|em|rem|%)$/];
const TEXT_ALIGN = [/^(left|right|center|justify)$/];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'blockquote',
    'a',
    'span',
    'hr',
    'code',
    'mark',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    span: ['style'],
    mark: ['style'],
    p: ['style'],
    h2: ['style'],
    h3: ['style'],
    h4: ['style'],
    li: ['style'],
  },
  allowedStyles: {
    '*': {
      color: COLOR,
      'background-color': COLOR,
      'font-family': FONT_FAMILY,
      'font-size': FONT_SIZE,
      'text-align': TEXT_ALIGN,
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...(attribs.href ? { href: attribs.href } : {}),
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
  },
};

export const RICH_TEXT_MAX_LENGTH = 50_000;

export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html.slice(0, RICH_TEXT_MAX_LENGTH * 2), OPTIONS)
    .trim()
    .slice(0, RICH_TEXT_MAX_LENGTH);
}

/** Plain text fallback (meta descriptions, legacy plain-text descriptions). */
export function richTextToPlain(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
}

/** Descriptions saved before rich text support are plain text → render line breaks safely. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function descriptionToHtml(value: string | null | undefined): string {
  if (!value) return '';
  // The rich-text editor always emits block-level root elements; anything else is legacy
  // plain text, which is escaped (so "<name>" stays visible) and split into paragraphs.
  if (/^\s*<(p|h[1-6]|ul|ol|blockquote|hr|div)\b/i.test(value)) return sanitizeRichText(value);
  return escapeHtml(value)
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
