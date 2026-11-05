import type {
  DocElement,
  DocEntrance,
  DocRow,
  DocSeat,
  DocSection,
  SeatMapDocument,
} from '@tix/shared';

/** Editor-wide types and constants (no React). */

export type Doc = SeatMapDocument;

export interface Collections {
  seats: DocSeat;
  rows: DocRow;
  sections: DocSection;
  elements: DocElement;
  entrances: DocEntrance;
}
export type EntityKind = keyof Collections;
export const ENTITY_KINDS: readonly EntityKind[] = [
  'seats',
  'rows',
  'sections',
  'elements',
  'entrances',
];

export type Tool =
  | 'select'
  | 'hand'
  | 'section-rect'
  | 'section-polygon'
  | 'row-straight'
  | 'row-arc'
  | 'table'
  | 'stage'
  | 'text'
  | 'shape-rect'
  | 'shape-ellipse'
  | 'shape-polygon'
  | 'line'
  | 'exit'
  | 'facility'
  | 'entrance';

/** Tools that stay active after an object was created (repetitive drawing). */
export const STICKY_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['row-straight', 'row-arc', 'table']);

export type Selection = Readonly<Record<EntityKind, ReadonlySet<string>>>;

export const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export const EMPTY_SELECTION: Selection = {
  seats: EMPTY_SET,
  rows: EMPTY_SET,
  sections: EMPTY_SET,
  elements: EMPTY_SET,
  entrances: EMPTY_SET,
};

export function selectOnly(kind: EntityKind, ids: Iterable<string>): Selection {
  return { ...EMPTY_SELECTION, [kind]: new Set(ids) };
}

export function selectionCount(sel: Selection): number {
  return ENTITY_KINDS.reduce((n, k) => n + sel[k].size, 0);
}

/** The only non-empty kind of the selection, if exactly one kind is selected. */
export function soleKind(sel: Selection): EntityKind | null {
  const kinds = ENTITY_KINDS.filter((k) => sel[k].size > 0);
  return kinds.length === 1 ? kinds[0]! : null;
}

export function toggleInSelection(sel: Selection, kind: EntityKind, id: string): Selection {
  const next = new Set(sel[kind]);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { ...sel, [kind]: next };
}

export function mergeSelection(a: Selection, b: Selection): Selection {
  const out = { ...a } as Record<EntityKind, ReadonlySet<string>>;
  for (const k of ENTITY_KINDS) {
    if (b[k].size === 0) continue;
    out[k] = new Set([...a[k], ...b[k]]);
  }
  return out;
}

/** Drops ids that no longer exist in the document (after undo / delete). */
export function pruneSelection(sel: Selection, doc: Doc): Selection {
  let changed = false;
  const out = { ...sel } as Record<EntityKind, ReadonlySet<string>>;
  for (const k of ENTITY_KINDS) {
    if (sel[k].size === 0) continue;
    const existing = new Set((doc[k] as { id: string }[]).map((e) => e.id));
    const kept = [...sel[k]].filter((id) => existing.has(id));
    if (kept.length !== sel[k].size) {
      out[k] = new Set(kept);
      changed = true;
    }
  }
  return changed ? out : sel;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 25;
export const HISTORY_LIMIT = 100;

export const COLORS = {
  noCategory: '#9ca3af',
  selection: '#2563eb',
  highlight: '#dc2626',
  sectionDefault: '#64748b',
  canvas: '#ffffff',
  outside: '#eef0f3',
  grid: '#eef0f3',
  gridMajor: '#dfe3e8',
  canvasBorder: '#94a3b8',
  rowGuide: '#cbd5e1',
  rowLabel: '#475569',
  blockedMark: '#111827',
  entrance: '#16a34a',
  exit: '#16a34a',
  stage: '#334155',
  table: '#e2e8f0',
  shape: '#e2e8f0',
  line: '#475569',
  preview: '#2563eb',
} as const;
