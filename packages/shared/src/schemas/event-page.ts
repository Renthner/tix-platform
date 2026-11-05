import { z } from 'zod';
import { INFO_BOX_SIZES, type InfoBoxSize } from '../enums';

/** Info box on the event page, e.g. "Accepted proofs of reduction" or accessibility notes. */
export const eventInfoBoxSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().max(120),
    /** Icon from the symbol library (svg_symbols.id); null = no icon. */
    symbolId: z.uuid().nullable(),
    /** Sanitised rich-text HTML. */
    content: z.string().max(50_000),
    /** Text size (title scales along); absent = M. */
    textSize: z.enum(INFO_BOX_SIZES).optional(),
    /** Icon size; absent = M. */
    iconSize: z.enum(INFO_BOX_SIZES).optional(),
  })
  .strict();
export type EventInfoBox = z.infer<typeof eventInfoBoxSchema>;

export const MAX_EVENT_INFO_BOXES = 6;
export const eventInfoBoxesSchema = z.array(eventInfoBoxSchema).max(MAX_EVENT_INFO_BOXES);

/** Pixel sizes of info box icons. */
export const INFO_BOX_ICON_PX: Record<InfoBoxSize, number> = { S: 24, M: 40, L: 56, XL: 80 };

// ─── Page layout (rows × columns) ───────────────────────────────────────────

/** A block of the event page: the description, the seating plan / shop or one info box. */
export type PageBlockRef = 'DESCRIPTION' | 'SHOP' | `box:${string}`;
export interface PageLayoutItem {
  ref: PageBlockRef;
  /** Relative width within its row (1 = normal, 2 = double). */
  span: 1 | 2;
}
/** Rows from top to bottom; items of a row are shown side by side (stacked on mobile). */
export type PageLayout = PageLayoutItem[][];

/** Items side by side in one row; the seating plan always has a row of its own. */
export const MAX_ITEMS_PER_ROW = 3;

export const boxRef = (id: string): PageBlockRef => `box:${id}`;

/**
 * Brings a stored layout into shape: every block exactly once (unknown / deleted boxes
 * dropped, missing blocks appended as own rows), the seating plan alone in its row, at most
 * MAX_ITEMS_PER_ROW items per row, no empty rows. Also converts the earlier flat format
 * (["SHOP", "DESCRIPTION", "INFO_BOXES"]): info boxes then sit two per row.
 */
export function normalizePageLayout(raw: unknown, boxIds: readonly string[]): PageLayout {
  const valid = new Set<string>(['DESCRIPTION', 'SHOP', ...boxIds.map(boxRef)]);
  let rows: { ref: string; span?: unknown }[][] = [];
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    for (const block of raw as string[]) {
      if (block === 'INFO_BOXES') {
        for (let i = 0; i < boxIds.length; i += 2)
          rows.push(boxIds.slice(i, i + 2).map((id) => ({ ref: boxRef(id) })));
      } else rows.push([{ ref: block }]);
    }
  } else if (Array.isArray(raw)) {
    rows = raw
      .filter(Array.isArray)
      .map((row) =>
        (row as unknown[]).filter(
          (item): item is { ref: string; span?: unknown } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { ref?: unknown }).ref === 'string',
        ),
      );
  }

  const seen = new Set<string>();
  const result: PageLayout = [];
  const pushRow = (items: PageLayoutItem[]) => {
    for (let i = 0; i < items.length; i += MAX_ITEMS_PER_ROW)
      result.push(items.slice(i, i + MAX_ITEMS_PER_ROW));
  };
  for (const row of rows) {
    let current: PageLayoutItem[] = [];
    for (const entry of row) {
      if (!valid.has(entry.ref) || seen.has(entry.ref)) continue;
      seen.add(entry.ref);
      const item: PageLayoutItem = {
        ref: entry.ref as PageBlockRef,
        span: entry.span === 2 ? 2 : 1,
      };
      if (item.ref === 'SHOP') {
        // The seating plan needs the full width: it always gets a row of its own.
        if (current.length) pushRow(current);
        result.push([{ ...item, span: 1 }]);
        current = [];
      } else current.push(item);
    }
    if (current.length) pushRow(current);
  }
  for (const ref of ['SHOP', 'DESCRIPTION', ...boxIds.map(boxRef)] as PageBlockRef[]) {
    if (!seen.has(ref)) result.push([{ ref, span: 1 }]);
  }
  return result;
}

/** Default layout of new events: seating plan, then the description. */
export const DEFAULT_PAGE_LAYOUT: PageLayout = [
  [{ ref: 'SHOP', span: 1 }],
  [{ ref: 'DESCRIPTION', span: 1 }],
];
