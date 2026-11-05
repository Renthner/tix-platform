import {
  curveLength,
  layoutRowSeats,
  seatNumbers,
  type DocElement,
  type DocEntrance,
  type DocRow,
  type DocSeat,
  type DocSection,
  type ElementGeometry,
  type Point,
  type RowGeometry,
  type SectionGeometry,
} from '@tix/shared';
import {
  curveTangent,
  translateCurve,
  translateRowGeometry,
  translateElementGeometry,
  translateLabel,
  translateSectionGeometry,
} from './geometry';
import type { Collections, Doc, EntityKind, Selection } from './model';

/**
 * Pure, immutable operations on the editor document. Every function returns the same
 * document reference when nothing changed (cheap no-op detection for the history).
 */

/**
 * RFC 4122 v4 id. `crypto.randomUUID` only exists in secure contexts (HTTPS / localhost);
 * the fallback keeps the editor usable when the admin portal is opened via plain HTTP on a LAN.
 */
export function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

type Curve = RowGeometry['curve'];

// ─── Generic entity updates ─────────────────────────────────────────────────

export function patchEntity<K extends EntityKind>(
  doc: Doc,
  kind: K,
  id: string,
  patch: Partial<Collections[K]>,
): Doc {
  const list = doc[kind] as Collections[K][];
  const index = list.findIndex((e) => e.id === id);
  if (index < 0) return doc;
  const current = list[index]!;
  const changed = (Object.keys(patch) as (keyof Collections[K])[]).some(
    (k) => current[k] !== patch[k],
  );
  if (!changed) return doc;
  const next = list.slice();
  next[index] = { ...current, ...patch };
  return { ...doc, [kind]: next };
}

export function patchSeats(
  doc: Doc,
  ids: ReadonlySet<string>,
  update: (seat: DocSeat) => DocSeat,
): Doc {
  let changed = false;
  const seats = doc.seats.map((s) => {
    if (!ids.has(s.id)) return s;
    const n = update(s);
    if (n !== s) changed = true;
    return n;
  });
  return changed ? { ...doc, seats } : doc;
}

// ─── Factories ──────────────────────────────────────────────────────────────

export function newSection(
  params: Pick<DocSection, 'type' | 'name' | 'ticketLabel' | 'geometry'> &
    Partial<Pick<DocSection, 'capacity' | 'color' | 'priceCategoryId'>>,
  doc: Doc,
): DocSection {
  return {
    id: uid(),
    type: params.type,
    name: params.name,
    ticketLabel: params.ticketLabel,
    geometry: params.geometry,
    label: null,
    color: params.color ?? null,
    sortOrder: doc.sections.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1,
    entranceId: null,
    priceCategoryId: params.priceCategoryId ?? null,
    capacity: params.type === 'STANDING' ? (params.capacity ?? 0) : null,
    bestAvailablePriority: 100,
    isBestAvailableEnabled: params.type === 'SEATED',
    isActive: true,
    showNameOnMap: true,
    showLabelOnTicket: true,
  };
}

export function newElement(
  type: DocElement['type'],
  geometry: ElementGeometry,
  doc: Doc,
  extra: Partial<Pick<DocElement, 'label' | 'style' | 'sectionId'>> = {},
): DocElement {
  return {
    id: uid(),
    type,
    sectionId: extra.sectionId ?? null,
    label: extra.label ?? null,
    geometry,
    style: extra.style ?? {},
    assetId: null,
    zIndex: doc.elements.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1,
  };
}

export function newEntrance(name: string, code: string, p: Point, doc: Doc): DocEntrance {
  return {
    id: uid(),
    name,
    code,
    x: round2(p.x),
    y: round2(p.y),
    sortOrder: doc.entrances.length + 1,
  };
}

function seatDefaults(): Omit<DocSeat, 'id' | 'sectionId' | 'label' | 'x' | 'y'> {
  return {
    rowId: null,
    tableElementId: null,
    position: null,
    rotation: 0,
    priceCategoryId: null,
    bestAvailableRank: null,
    isWheelchairSpace: false,
    isCompanionSeat: false,
    companionOfSeatId: null,
    hasRestrictedView: false,
    blockReason: null,
    blockNote: null,
    attributes: {},
    symbolId: null,
  };
}

// ─── Rows ───────────────────────────────────────────────────────────────────

/** A, B … Z, AA, AB …  /  1, 2, 3 …  /  any other text gets a running suffix. */
export function nthLabel(base: string, n: number): string {
  if (n === 0) return base;
  if (/^\d+$/.test(base)) return String(Number(base) + n);
  if (/^[A-Z]+$/.test(base) || /^[a-z]+$/.test(base)) {
    const upper = base === base.toUpperCase();
    let value = 0;
    for (const ch of base.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
    value += n;
    let out = '';
    while (value > 0) {
      const rem = (value - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      value = Math.floor((value - 1) / 26);
    }
    return upper ? out : out.toLowerCase();
  }
  return `${base}${n + 1}`;
}

export interface RowSpec {
  sectionId: string;
  label: string;
  curve: Curve;
  mode: 'count' | 'spacing';
  count: number;
  spacing: number;
  numbering: RowGeometry['numbering'];
  labelPlacement: RowGeometry['labelPlacement'];
  startNumber: number;
  /** Number of parallel rows to create (≥ 1). */
  rows: number;
  /** Distance between parallel rows (world units, perpendicular to the row). */
  rowOffset: number;
  /** Label of the n-th row is `nthLabel(label, n)` going "backwards" from the stage. */
}

export const MAX_SEATS_PER_ROW = 500;

/** Number of seats a spec produces for one row. */
export function seatCountFor(spec: Pick<RowSpec, 'mode' | 'count' | 'spacing' | 'curve'>): number {
  if (spec.mode === 'count')
    return Math.max(1, Math.min(MAX_SEATS_PER_ROW, Math.round(spec.count)));
  const length = curveLength(spec.curve);
  return Math.max(
    1,
    Math.min(MAX_SEATS_PER_ROW, Math.floor(length / Math.max(1, spec.spacing)) + 1),
  );
}

/** Labels of the rows a spec would create (for conflict checks in the dialog). */
export function rowLabelsFor(spec: Pick<RowSpec, 'label' | 'rows'>): string[] {
  return Array.from({ length: Math.max(1, spec.rows) }, (_, i) => nthLabel(spec.label, i));
}

export function buildRows(doc: Doc, spec: RowSpec): { rows: DocRow[]; seats: DocSeat[] } {
  const section = doc.sections.find((s) => s.id === spec.sectionId);
  const defaultCategory = section?.priceCategoryId ?? null;
  const start = spec.curve.start;
  const end = spec.curve.end;
  const len = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  // Perpendicular pointing "down" for a left→right row (away from a stage at the top).
  const normal = { x: -(end.y - start.y) / len, y: (end.x - start.x) / len };
  const baseSort = doc.rows
    .filter((r) => r.sectionId === spec.sectionId)
    .reduce((m, r) => Math.max(m, r.sortOrder), 0);

  const rows: DocRow[] = [];
  const seats: DocSeat[] = [];
  const count = seatCountFor(spec);
  for (let i = 0; i < Math.max(1, spec.rows); i += 1) {
    const curve = translateCurve(
      spec.curve,
      normal.x * spec.rowOffset * i,
      normal.y * spec.rowOffset * i,
    );
    const row: DocRow = {
      id: uid(),
      sectionId: spec.sectionId,
      label: nthLabel(spec.label, i),
      sortOrder: baseSort + i + 1,
      geometry: {
        curve,
        seatSpacing: round2(
          count > 1 ? curveLength(curve) / (count - 1) : Math.max(1, spec.spacing),
        ),
        numbering: spec.numbering,
        labelPlacement: spec.labelPlacement,
      },
    };
    rows.push(row);
    const placed = layoutRowSeats(curve, count);
    const labels = seatNumbers(count, spec.numbering, spec.startNumber);
    placed.forEach((p, j) => {
      seats.push({
        ...seatDefaults(),
        id: uid(),
        sectionId: spec.sectionId,
        rowId: row.id,
        label: labels[j]!,
        position: j + 1,
        x: p.x,
        y: p.y,
        rotation: p.rotation,
        priceCategoryId: defaultCategory,
      });
    });
  }
  return { rows, seats };
}

function inferStartNumber(seats: DocSeat[]): number {
  const numeric = seats.map((s) => Number(s.label)).filter((n) => Number.isInteger(n) && n > 0);
  return numeric.length ? Math.min(...numeric) : 1;
}

/**
 * Re-distributes the seats of a row along its (possibly edited) curve. Existing seat ids
 * are kept in position order; `count` adds or removes seats at the end; `relabel`
 * renumbers all seats with the row's numbering scheme.
 */
export function reflowRow(
  doc: Doc,
  rowId: string,
  options: { count?: number; relabel?: boolean; startNumber?: number } = {},
): Doc {
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row) return doc;
  const current = doc.seats
    .filter((s) => s.rowId === rowId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const count = Math.max(
    1,
    Math.min(MAX_SEATS_PER_ROW, options.count ?? Math.max(current.length, 1)),
  );
  const placed = layoutRowSeats(row.geometry.curve, count, row.geometry.seatOrientation);
  const start = options.startNumber ?? inferStartNumber(current);
  const labels = seatNumbers(count, row.geometry.numbering, start);
  const template = current[0];
  const section = doc.sections.find((s) => s.id === row.sectionId);
  let nextNumber = Math.max(
    start + current.length,
    ...current.map((s) => Number(s.label) + 1).filter(Number.isFinite),
  );

  const rowSeats: DocSeat[] = placed.map((p, i) => {
    const existing = current[i];
    if (existing) {
      return {
        ...existing,
        x: p.x,
        y: p.y,
        rotation: p.rotation,
        position: i + 1,
        label: options.relabel ? labels[i]! : existing.label,
      };
    }
    return {
      ...seatDefaults(),
      id: uid(),
      sectionId: row.sectionId,
      rowId,
      label: options.relabel ? labels[i]! : String(nextNumber++),
      position: i + 1,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      priceCategoryId: template?.priceCategoryId ?? section?.priceCategoryId ?? null,
    };
  });

  const others = doc.seats.filter((s) => s.rowId !== rowId);
  const spacing = round2(
    count > 1 ? curveLength(row.geometry.curve) / (count - 1) : row.geometry.seatSpacing,
  );
  const rows = doc.rows.map((r) =>
    r.id === rowId ? { ...r, geometry: { ...r.geometry, seatSpacing: spacing } } : r,
  );
  return { ...doc, rows, seats: [...others, ...rowSeats] };
}

/** Moves one control handle of a row curve and re-flows its seats. */
export function moveRowHandle(
  doc: Doc,
  rowId: string,
  handle: 'start' | 'end' | 'control',
  p: Point,
): Doc {
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row) return doc;
  const curve = row.geometry.curve;
  const point = { x: round2(p.x), y: round2(p.y) };
  let next: Curve;
  if (handle === 'control') {
    if (curve.type !== 'arc') return doc;
    next = { ...curve, control: point };
  } else {
    next = { ...curve, [handle]: point } as Curve;
  }
  const withCurve = patchEntity(doc, 'rows', rowId, { geometry: { ...row.geometry, curve: next } });
  return reflowRow(withCurve, rowId);
}

export function setRowCurveType(doc: Doc, rowId: string, type: Curve['type']): Doc {
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row || row.geometry.curve.type === type) return doc;
  const { start, end } = row.geometry.curve;
  const curve: Curve =
    type === 'straight'
      ? { type: 'straight', start, end }
      : {
          type: 'arc',
          start,
          end,
          control: {
            x: round2((start.x + end.x) / 2 - curveTangent(row.geometry.curve, 0.5).y * 30),
            y: round2((start.y + end.y) / 2 + curveTangent(row.geometry.curve, 0.5).x * 30),
          },
        };
  return reflowRow(
    patchEntity(doc, 'rows', rowId, { geometry: { ...row.geometry, curve } }),
    rowId,
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────────

export interface TableSpec {
  sectionId: string;
  center: Point;
  label: string;
  seatCount: number;
  tableRadius: number;
  startNumber: number;
}

export function buildTable(doc: Doc, spec: TableSpec): { element: DocElement; seats: DocSeat[] } {
  const section = doc.sections.find((s) => s.id === spec.sectionId);
  const element = newElement(
    'TABLE',
    {
      type: 'ellipse',
      cx: round2(spec.center.x),
      cy: round2(spec.center.y),
      rx: spec.tableRadius,
      ry: spec.tableRadius,
      rotation: 0,
    },
    doc,
    { label: spec.label || null, sectionId: spec.sectionId },
  );
  const radius = spec.tableRadius + doc.settings.seatRadius * 1.7;
  const n = Math.max(1, Math.min(60, Math.round(spec.seatCount)));
  const seats: DocSeat[] = Array.from({ length: n }, (_, i) => {
    const angle = -90 + (i * 360) / n;
    const rad = (angle * Math.PI) / 180;
    return {
      ...seatDefaults(),
      id: uid(),
      sectionId: spec.sectionId,
      tableElementId: element.id,
      label: String(spec.startNumber + i),
      position: i + 1,
      x: round2(spec.center.x + Math.cos(rad) * radius),
      y: round2(spec.center.y + Math.sin(rad) * radius),
      rotation: round2(angle + 90),
      priceCategoryId: section?.priceCategoryId ?? null,
    };
  });
  return { element, seats };
}

// ─── Move / delete ──────────────────────────────────────────────────────────

export type EntitySets = Record<EntityKind, Set<string>>;

/** Everything that moves with the selection (sections carry rows, seats and elements). */
export function collectMoveSet(doc: Doc, sel: Selection): EntitySets {
  const sections = new Set(sel.sections);
  const rows = new Set(sel.rows);
  for (const r of doc.rows) if (sections.has(r.sectionId)) rows.add(r.id);
  const elements = new Set(sel.elements);
  for (const e of doc.elements) if (e.sectionId && sections.has(e.sectionId)) elements.add(e.id);
  const seats = new Set(sel.seats);
  for (const s of doc.seats) {
    if (
      sections.has(s.sectionId) ||
      (s.rowId !== null && rows.has(s.rowId)) ||
      (s.tableElementId !== null && elements.has(s.tableElementId))
    ) {
      seats.add(s.id);
    }
  }
  return { sections, rows, elements, seats, entrances: new Set(sel.entrances) };
}

export function translateEntities(doc: Doc, set: EntitySets, dx: number, dy: number): Doc {
  if (dx === 0 && dy === 0) return doc;
  return {
    ...doc,
    sections: doc.sections.map((s) =>
      set.sections.has(s.id)
        ? {
            ...s,
            geometry: translateSectionGeometry(s.geometry, dx, dy),
            label: translateLabel(s.label, dx, dy),
          }
        : s,
    ),
    rows: doc.rows.map((r) =>
      set.rows.has(r.id) ? { ...r, geometry: translateRowGeometry(r.geometry, dx, dy) } : r,
    ),
    elements: doc.elements.map((e) =>
      set.elements.has(e.id) ? { ...e, geometry: translateElementGeometry(e.geometry, dx, dy) } : e,
    ),
    seats: doc.seats.map((s) =>
      set.seats.has(s.id) ? { ...s, x: round2(s.x + dx), y: round2(s.y + dy) } : s,
    ),
    entrances: doc.entrances.map((e) =>
      set.entrances.has(e.id) ? { ...e, x: round2(e.x + dx), y: round2(e.y + dy) } : e,
    ),
  };
}

/** Deletes the selection including dependent rows / seats / table seats. */
export function deleteSelection(doc: Doc, sel: Selection): Doc {
  const sections = new Set(sel.sections);
  const rows = new Set(sel.rows);
  for (const r of doc.rows) if (sections.has(r.sectionId)) rows.add(r.id);
  const elements = new Set(sel.elements);
  for (const e of doc.elements) if (e.sectionId && sections.has(e.sectionId)) elements.add(e.id);
  const seats = new Set(sel.seats);
  for (const s of doc.seats) {
    if (
      sections.has(s.sectionId) ||
      (s.rowId !== null && rows.has(s.rowId)) ||
      (s.tableElementId !== null && elements.has(s.tableElementId))
    ) {
      seats.add(s.id);
    }
  }
  const entrances = new Set(sel.entrances);
  if (sections.size + rows.size + elements.size + seats.size + entrances.size === 0) return doc;
  return {
    ...doc,
    sections: doc.sections
      .filter((s) => !sections.has(s.id))
      .map((s) => (s.entranceId && entrances.has(s.entranceId) ? { ...s, entranceId: null } : s)),
    rows: doc.rows.filter((r) => !rows.has(r.id)),
    elements: doc.elements.filter((e) => !elements.has(e.id)),
    seats: doc.seats.filter((s) => !seats.has(s.id)),
    entrances: doc.entrances.filter((e) => !entrances.has(e.id)),
  };
}

// ─── Sections ───────────────────────────────────────────────────────────────

/** Changes the section type. Turning a section into STANDING removes its rows and seats. */
export function setSectionType(doc: Doc, sectionId: string, type: DocSection['type']): Doc {
  const section = doc.sections.find((s) => s.id === sectionId);
  if (!section || section.type === type) return doc;
  if (type === 'STANDING') {
    const seatCount = doc.seats.filter((s) => s.sectionId === sectionId).length;
    return {
      ...doc,
      sections: doc.sections.map((s) =>
        s.id === sectionId
          ? { ...s, type, capacity: s.capacity ?? seatCount, isBestAvailableEnabled: false }
          : s,
      ),
      rows: doc.rows.filter((r) => r.sectionId !== sectionId),
      seats: doc.seats.filter((s) => s.sectionId !== sectionId),
    };
  }
  return patchEntity(doc, 'sections', sectionId, {
    type,
    capacity: null,
    isBestAvailableEnabled: true,
  });
}

export function setSectionGeometry(doc: Doc, sectionId: string, geometry: SectionGeometry): Doc {
  return patchEntity(doc, 'sections', sectionId, { geometry });
}

// ─── Seats ──────────────────────────────────────────────────────────────────

/** Renumbers the given seats per row / table in position order, starting at `start`. */
export function renumberSeats(doc: Doc, ids: ReadonlySet<string>, start: number): Doc {
  const groups = new Map<string, DocSeat[]>();
  for (const s of doc.seats) {
    if (!ids.has(s.id)) continue;
    const key = s.rowId ?? s.tableElementId ?? `loose:${s.sectionId}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const labels = new Map<string, string>();
  for (const list of groups.values()) {
    list.sort((a, b) => (a.position ?? a.x) - (b.position ?? b.x));
    list.forEach((s, i) => labels.set(s.id, String(start + i)));
  }
  return patchSeats(doc, ids, (s) =>
    labels.get(s.id) === s.label ? s : { ...s, label: labels.get(s.id)! },
  );
}

// ─── Statistics ─────────────────────────────────────────────────────────────

export interface DocStats {
  seats: number;
  blocked: number;
  wheelchair: number;
  companion: number;
  unassigned: number;
  byCategory: Map<string, number>;
  standingCapacity: number;
  sections: number;
  rows: number;
}

export function computeStats(doc: Doc): DocStats {
  const byCategory = new Map<string, number>();
  let blocked = 0;
  let wheelchair = 0;
  let companion = 0;
  let unassigned = 0;
  for (const s of doc.seats) {
    if (s.blockReason) blocked += 1;
    if (s.isWheelchairSpace) wheelchair += 1;
    if (s.isCompanionSeat) companion += 1;
    if (s.priceCategoryId)
      byCategory.set(s.priceCategoryId, (byCategory.get(s.priceCategoryId) ?? 0) + 1);
    else unassigned += 1;
  }
  return {
    seats: doc.seats.length,
    blocked,
    wheelchair,
    companion,
    unassigned,
    byCategory,
    standingCapacity: doc.sections
      .filter((s) => s.type === 'STANDING' && s.isActive)
      .reduce((n, s) => n + (s.capacity ?? 0), 0),
    sections: doc.sections.length,
    rows: doc.rows.length,
  };
}

/**
 * Drops companion assignments that are no longer valid (seat is no companion seat any more,
 * target deleted or no longer a wheelchair space) – applied before saving.
 */
export function normalizeCompanions(doc: Doc): Doc {
  const wheelchair = new Set(doc.seats.filter((s) => s.isWheelchairSpace).map((s) => s.id));
  let changed = false;
  const seats = doc.seats.map((s) => {
    if (!s.companionOfSeatId) return s;
    if (s.isCompanionSeat && wheelchair.has(s.companionOfSeatId) && s.companionOfSeatId !== s.id)
      return s;
    changed = true;
    return { ...s, companionOfSeatId: null };
  });
  return changed ? { ...doc, seats } : doc;
}
