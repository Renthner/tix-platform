import { svgSymbols, type Executor } from '@tix/db';
import type { PublicSymbol, SymbolKind } from '@tix/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import { DomainError } from './context';

/**
 * SVG symbol library (seat shapes, element icons).
 *
 * Uploaded SVG is untrusted. It is reduced to a strict allowlist: shape elements and
 * geometry / paint attributes only. Scripts, event handlers, <style>, <use>, <image>,
 * <foreignObject>, href / xlink:href, `style` attributes and `url(...)` paint are removed,
 * so the stored markup can be inlined into pages and rasterised by the editor safely.
 */

const MAX_INPUT_BYTES = 200_000;
const MAX_MARKUP_CHARS = 50_000;
const MAX_ELEMENTS = 2_000;

const SHAPES = ['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'];
const GEOMETRY: Record<string, string[]> = {
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  g: [],
};
const PAINT = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'fill-rule',
  'clip-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'transform',
];

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE\s,.\-+]*$/;
const POINTS = /^[0-9eE\s,.\-+]*$/;
const COLOR = /^(none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d\s.,%]+\))$/;
const TRANSFORM = /^((matrix|translate|scale|rotate|skewX|skewY)\(\s*[-\d.eE\s,]+\)\s*)+$/;
const KEYWORD = /^[a-z-]{2,20}$/;

function validAttribute(name: string, value: string): boolean {
  if (value.length > 20_000) return false;
  switch (name) {
    case 'd':
      return PATH_DATA.test(value);
    case 'points':
      return POINTS.test(value);
    case 'fill':
    case 'stroke':
      return COLOR.test(value.trim());
    case 'transform':
      return TRANSFORM.test(value.trim());
    case 'stroke-linecap':
    case 'stroke-linejoin':
    case 'fill-rule':
    case 'clip-rule':
      return KEYWORD.test(value);
    default:
      return NUMBER.test(value.trim().replace(/px$/, ''));
  }
}

export interface SanitizedSvg {
  viewBox: string;
  markup: string;
}

/**
 * Sanitises an uploaded SVG document. With `colorize`, every non-`none` fill / stroke is
 * replaced by `currentColor` so the symbol takes the colour of the seat / element.
 */
export function sanitizeSvg(input: string, colorize: boolean): SanitizedSvg {
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new DomainError('SVG_TOO_LARGE', 'The SVG file is too large (max 200 KB)', 422);
  }
  const root = /<svg\b([^>]*)>/i.exec(input);
  if (!root) throw new DomainError('SVG_INVALID', 'The file is not an SVG image', 422);

  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root[1] ?? '')?.[1];
  let viewBox = attr('viewBox')
    ?.trim()
    .replace(/[\s,]+/g, ' ');
  if (!viewBox || !/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(viewBox)) {
    const w = Number.parseFloat(attr('width') ?? '');
    const h = Number.parseFloat(attr('height') ?? '');
    if (!(w > 0 && h > 0)) {
      throw new DomainError('SVG_INVALID', 'The SVG needs a viewBox or width/height', 422);
    }
    viewBox = `0 0 ${w} ${h}`;
  }

  let elements = 0;
  const allowedAttributes = Object.fromEntries(
    SHAPES.map((tag) => [tag, [...(GEOMETRY[tag] ?? []), ...PAINT]]),
  );
  const markup = sanitizeHtml(
    input.slice(root.index + root[0].length).replace(/<\/svg>[\s\S]*$/i, ''),
    {
      allowedTags: SHAPES,
      allowedAttributes,
      allowedSchemes: [],
      allowProtocolRelative: false,
      disallowedTagsMode: 'discard',
      nonTextTags: [
        'script',
        'style',
        'textarea',
        'option',
        'title',
        'desc',
        'metadata',
        'defs',
        'foreignObject',
      ],
      parser: { lowerCaseTags: false, lowerCaseAttributeNames: false, xmlMode: true },
      transformTags: {
        '*': (tagName, attribs) => {
          elements += 1;
          const clean: Record<string, string> = {};
          for (const [name, value] of Object.entries(attribs)) {
            if (!validAttribute(name, value)) continue;
            clean[name] =
              colorize && (name === 'fill' || name === 'stroke') && value.trim() !== 'none'
                ? 'currentColor'
                : value;
          }
          return { tagName, attribs: clean };
        },
      },
      textFilter: () => '',
    },
  )
    .replace(/>\s+</g, '><')
    .trim();

  if (elements > MAX_ELEMENTS)
    throw new DomainError('SVG_TOO_COMPLEX', 'The SVG has too many elements', 422);
  if (!markup || !/<(path|circle|ellipse|rect|line|polyline|polygon)\b/.test(markup)) {
    throw new DomainError('SVG_EMPTY', 'The SVG contains no drawable shapes', 422);
  }
  if (markup.length > MAX_MARKUP_CHARS) {
    throw new DomainError('SVG_TOO_COMPLEX', 'The SVG is too complex after cleaning', 422);
  }
  return { viewBox, markup };
}

export type SymbolRow = typeof svgSymbols.$inferSelect;

export async function listSymbols(db: Executor, kind?: SymbolKind): Promise<SymbolRow[]> {
  const query = db.select().from(svgSymbols);
  return kind
    ? query.where(eq(svgSymbols.kind, kind)).orderBy(asc(svgSymbols.name))
    : query.orderBy(asc(svgSymbols.kind), asc(svgSymbols.name));
}

export async function createSymbol(
  db: Executor,
  params: {
    name: string;
    kind: SymbolKind;
    svg: string;
    colorize: boolean;
    createdByUserId: string | null;
  },
): Promise<SymbolRow> {
  const { viewBox, markup } = sanitizeSvg(params.svg, params.colorize);
  const [row] = await db
    .insert(svgSymbols)
    .values({
      name: params.name.trim().slice(0, 120),
      kind: params.kind,
      viewBox,
      markup,
      colorize: params.colorize,
      createdByUserId: params.createdByUserId,
    })
    .returning();
  return row!;
}

export function toPublicSymbol(
  row: Pick<SymbolRow, 'id' | 'viewBox' | 'markup' | 'colorize'>,
): PublicSymbol {
  return { id: row.id, viewBox: row.viewBox, markup: row.markup, colorize: row.colorize };
}

export async function symbolsByIds(db: Executor, ids: Iterable<string>): Promise<PublicSymbol[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return [];
  const rows = await db
    .select({
      id: svgSymbols.id,
      viewBox: svgSymbols.viewBox,
      markup: svgSymbols.markup,
      colorize: svgSymbols.colorize,
    })
    .from(svgSymbols)
    .where(inArray(svgSymbols.id, unique));
  return rows.map(toPublicSymbol);
}
