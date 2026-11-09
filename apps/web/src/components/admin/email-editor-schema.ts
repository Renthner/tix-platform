import { Color, TextStyle } from '@tiptap/extension-text-style';
import { Extension, Node, type AnyExtension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

/**
 * TipTap schema of the e-mail visual editor. E-mail HTML is table based and carries inline
 * styles, so the editor keeps `style` attributes and understands tables; `{{placeholders}}` are
 * plain text and valid link targets. `{{#if}}` lines and generated block placeholders are
 * non-editable "logic chips" (see `protectEmailLogic`). Kept free of React/UI imports so it can
 * also run outside the admin UI (tests, bundles).
 */

/** Link targets: web, mail, phone or a placeholder such as {{orderUrl}}. */
export const ALLOWED_LINK = /^(https?:\/\/|mailto:|tel:|\{\{[^{}]+\}\})/i;

/** Style of the "button" links used by the default templates. */
export const BUTTON_STYLE =
  'display:inline-block;background:{{accentColor}};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600';

const styleAttribute = {
  default: null,
  parseHTML: (el: HTMLElement) => el.getAttribute('style'),
  // The browser normalises `style` while rendering and drops values it cannot parse
  // (`background:{{accentColor}}`), so the raw string travels along in `data-tpl-style` and
  // `restoreEmailLogic` puts it back.
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs.style ? { style: attrs.style, 'data-tpl-style': attrs.style } : {},
};

/** Keeps inline styles of the supported block nodes and link marks. */
const InlineStyles = Extension.create({
  name: 'emailInlineStyles',
  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'blockquote',
          'listItem',
          'bulletList',
          'orderedList',
          'link',
          'emailTable',
          'emailRow',
          'emailCell',
        ],
        attributes: { style: styleAttribute },
      },
    ];
  },
});

function passthrough(names: readonly string[]) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute(name),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs[name] != null ? { [name]: attrs[name] } : {},
      },
    ]),
  );
}

// Minimal table support (structure + text editing; no row/column commands).
const EmailTable = Node.create({
  name: 'emailTable',
  group: 'block',
  content: 'emailRow+',
  isolating: true,
  parseHTML: () => [{ tag: 'table' }],
  renderHTML: ({ HTMLAttributes }) => ['table', HTMLAttributes, ['tbody', 0]],
  addAttributes: () =>
    passthrough(['width', 'cellpadding', 'cellspacing', 'border', 'role', 'align']),
});

const EmailRow = Node.create({
  name: 'emailRow',
  content: 'emailCell+',
  parseHTML: () => [{ tag: 'tr' }],
  renderHTML: ({ HTMLAttributes }) => ['tr', HTMLAttributes, 0],
});

const EmailCell = Node.create({
  name: 'emailCell',
  content: 'block+',
  isolating: true,
  parseHTML: () => [{ tag: 'td' }, { tag: 'th' }],
  renderHTML: ({ HTMLAttributes }) => ['td', HTMLAttributes, 0],
  addAttributes: () => passthrough(['colspan', 'rowspan', 'align', 'valign', 'width']),
});

const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\}\}\s+\{\{/g, '}}{{')
    .trim();

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

/** Structure fingerprint compared before/after a round trip through the editor. */
export function signature(html: string): string {
  return JSON.stringify([
    visibleText(html),
    count(html, /<table\b/gi),
    count(html, /<tr\b/gi),
    count(html, /<td\b|<th\b/gi),
    count(html, /<a\b/gi),
    count(html, /<img\b/gi),
    count(html, /<li\b/gi),
    [...html.matchAll(/href="([^"]*)"/gi)].map((m) => m[1]),
  ]);
}

/** A `{{#if …}}` / `{{else}}` / `{{/if}}` line or block placeholder: atomic, not editable. */
export const EmailLogic = Node.create({
  name: 'emailLogic',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: 'div[data-tpl]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', HTMLAttributes],
  addAttributes: () => ({
    code: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-tpl') ?? '',
      renderHTML: (attrs: Record<string, unknown>) => ({
        'data-tpl': String(attrs.code ?? ''),
        class: 'tpl-chip',
        contenteditable: 'false',
      }),
    },
  }),
});

export function emailEditorExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false,
      code: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        autolink: false,
        defaultProtocol: 'https',
        protocols: ['mailto', 'tel'],
        isAllowedUri: (url) => ALLOWED_LINK.test(url),
        HTMLAttributes: { target: null, rel: null, class: null },
      },
    }),
    TextStyle,
    Color,
    InlineStyles,
    EmailTable,
    EmailRow,
    EmailCell,
    EmailLogic,
  ];
}
