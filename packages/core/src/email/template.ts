/**
 * Minimal, logic-less template language for e-mail templates stored in the database.
 *
 *   {{name}}                         value, HTML-escaped in HTML bodies
 *   {{#if name}} … {{else}} … {{/if}}   section shown when the value is non-empty
 *   {{#unless name}} … {{/unless}}      section shown when the value is empty
 *
 * Values are plain strings/numbers (always escaped) or `TrustedHtml` produced by the
 * application itself (item tables, event lists) – those are inserted as-is into HTML and as
 * their plain-text twin into text bodies. There is deliberately no syntax to insert
 * arbitrary raw HTML, so customer-controlled data (names, notes) can never inject markup.
 */

export class TrustedHtml {
  constructor(
    readonly html: string,
    readonly text: string,
  ) {}
}

export const trustedHtml = (html: string, text: string) => new TrustedHtml(html, text);

export type TemplateValue = string | number | boolean | TrustedHtml | null | undefined;
export type TemplateVariables = Record<string, TemplateValue>;

export type TemplateSyntaxCode =
  'emptyPlaceholder' | 'missingName' | 'unexpectedElse' | 'unexpectedClose' | 'unclosedSection';

export class TemplateSyntaxError extends Error {
  override name = 'TemplateSyntaxError';
  constructor(
    message: string,
    /** Stable code + params so the admin UI can translate the message. */
    readonly code: TemplateSyntaxCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

type Node =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string }
  | { type: 'section'; name: string; negate: boolean; body: Node[]; alternative: Node[] };

const TAG = /\{\{\s*(#if|#unless|else|\/if|\/unless)?\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\}\}/g;

export function parseTemplate(source: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Extract<Node, { type: 'section' }>; inElse: boolean }[] = [];
  const target = (): Node[] => {
    const top = stack.at(-1);
    if (!top) return root;
    return top.inElse ? top.node.alternative : top.node.body;
  };
  let last = 0;
  for (const match of source.matchAll(TAG)) {
    const index = match.index;
    if (index > last) target().push({ type: 'text', value: source.slice(last, index) });
    last = index + match[0].length;
    const [, keyword, name] = match;
    switch (keyword) {
      case undefined:
        if (!name)
          throw new TemplateSyntaxError(
            `Empty placeholder at offset ${index}`,
            'emptyPlaceholder',
            {
              offset: index,
            },
          );
        target().push({ type: 'var', name });
        break;
      case '#if':
      case '#unless': {
        if (!name)
          throw new TemplateSyntaxError(`${keyword} without a variable name`, 'missingName', {
            keyword,
          });
        const node: Extract<Node, { type: 'section' }> = {
          type: 'section',
          name,
          negate: keyword === '#unless',
          body: [],
          alternative: [],
        };
        target().push(node);
        stack.push({ node, inElse: false });
        break;
      }
      case 'else': {
        const top = stack.at(-1);
        if (!top || top.inElse)
          throw new TemplateSyntaxError(`Unexpected {{else}}`, 'unexpectedElse');
        top.inElse = true;
        break;
      }
      case '/if':
      case '/unless': {
        const top = stack.pop();
        const expected = keyword === '/if' ? false : true;
        if (!top || top.node.negate !== expected) {
          throw new TemplateSyntaxError(`Unexpected {{${keyword}}}`, 'unexpectedClose', {
            keyword,
          });
        }
        break;
      }
    }
  }
  if (last < source.length) target().push({ type: 'text', value: source.slice(last) });
  const open = stack.at(-1);
  if (open) {
    const kind = open.node.negate ? 'unless' : 'if';
    throw new TemplateSyntaxError(`Unclosed {{#${kind} …}}`, 'unclosedSection', { kind });
  }
  return root;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

function isPresent(value: TemplateValue): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value instanceof TrustedHtml) return value.html.trim() !== '';
  if (typeof value === 'number') return value !== 0;
  if (value === true) return true;
  return value.trim() !== '';
}

function stringify(value: TemplateValue, mode: 'html' | 'text'): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof TrustedHtml) return mode === 'html' ? value.html : value.text;
  const text = value === true ? '' : String(value);
  return mode === 'html' ? escapeHtml(text) : text;
}

export interface RenderResult {
  output: string;
  /** Placeholders without a value (rendered empty) – useful for the template editor. */
  missing: string[];
}

export function renderTemplate(
  source: string,
  variables: TemplateVariables,
  mode: 'html' | 'text',
): RenderResult {
  const missing = new Set<string>();
  const walk = (nodes: Node[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case 'text':
            return node.value;
          case 'var':
            if (!Object.hasOwn(variables, node.name)) missing.add(node.name);
            return stringify(variables[node.name], mode);
          case 'section': {
            if (!Object.hasOwn(variables, node.name)) missing.add(node.name);
            const present = isPresent(variables[node.name]);
            return walk(present !== node.negate ? node.body : node.alternative);
          }
        }
      })
      .join('');
  return { output: walk(parseTemplate(source)), missing: [...missing] };
}

/** Every placeholder / section variable used in a template (editor hints, validation). */
export function templatePlaceholders(source: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type === 'var') names.add(node.name);
      if (node.type === 'section') {
        names.add(node.name);
        walk(node.body);
        walk(node.alternative);
      }
    }
  };
  walk(parseTemplate(source));
  return [...names];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Plain-text alternative for an already rendered HTML body (used when a template has no
 * explicit text version): keeps paragraphs, line breaks, list items and link targets.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, label) => {
      const inner = String(label)
        .replace(/<[^>]+>/g, '')
        .trim();
      const target = decodeEntities(String(href));
      if (!inner || decodeEntities(inner) === target) return target;
      return /^(mailto:|https?:|\{\{)/i.test(target)
        ? `${inner} (${target.replace(/^mailto:/i, '')})`
        : inner;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
