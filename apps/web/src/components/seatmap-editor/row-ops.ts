import {
  orientSeat,
  tangentAngleNear,
  type DocRow,
  type DocSeat,
  type Point,
  type SeatOrientation,
} from '@tix/shared';
import { patchEntity, patchSeats, uid } from './doc-ops';
import { curveParameterOf, rowLabelPoints, rowSeatEnds, subCurve } from './geometry';
import type { Doc, Selection } from './model';

/**
 * Row restructuring: splitting rows, moving rows / seats between blocks and positioning
 * row labels. All functions are pure and keep the document schema rules intact (unique
 * row label per block, unique position per row).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `desired` if free in the block, else `desired-2`, `desired-3` … */
export function uniqueRowLabel(
  doc: Doc,
  sectionId: string,
  desired: string,
  ignoreRowId?: string,
): string {
  const taken = new Set(
    doc.rows.filter((r) => r.sectionId === sectionId && r.id !== ignoreRowId).map((r) => r.label),
  );
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${desired.slice(0, 26)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return uid().slice(0, 8);
}

export function rowSeatsInOrder(doc: Doc, rowId: string): DocSeat[] {
  return doc.seats
    .filter((s) => s.rowId === rowId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/**
 * Splits a row after its `firstPartSize`-th seat (position order). The second part becomes
 * a new row with its own label in the target block. Both curves are exact sub-curves of the
 * original (de Casteljau), seat ids / labels / positions are kept, and explicit label
 * positions stay with the side they belong to.
 */
export function splitRow(
  doc: Doc,
  rowId: string,
  firstPartSize: number,
  newLabel: string,
  targetSectionId: string,
): { doc: Doc; newRowId: string } | null {
  const row = doc.rows.find((r) => r.id === rowId);
  const target = doc.sections.find((s) => s.id === targetSectionId && s.type === 'SEATED');
  if (!row || !target) return null;
  const seats = rowSeatsInOrder(doc, rowId);
  if (firstPartSize < 1 || firstPartSize >= seats.length) return null;
  const first = seats.slice(0, firstPartSize);
  const second = seats.slice(firstPartSize);
  const curve = row.geometry.curve;
  const t = (s: DocSeat) => curveParameterOf(curve, s);

  const { labelStart, labelEnd, ...base } = row.geometry;
  const firstGeometry = {
    ...base,
    curve: subCurve(curve, t(first[0]!), t(first[first.length - 1]!)),
    ...(labelStart ? { labelStart } : {}),
  };
  const newRow: DocRow = {
    id: uid(),
    sectionId: targetSectionId,
    label: newLabel,
    sortOrder: row.sortOrder,
    geometry: {
      ...base,
      curve: subCurve(curve, t(second[0]!), t(second[second.length - 1]!)),
      ...(labelEnd ? { labelEnd } : {}),
    },
  };
  const secondIds = new Set(second.map((s) => s.id));
  return {
    newRowId: newRow.id,
    doc: {
      ...doc,
      rows: [
        ...doc.rows.map((r) => (r.id === rowId ? { ...r, geometry: firstGeometry } : r)),
        newRow,
      ],
      seats: doc.seats.map((s) =>
        secondIds.has(s.id) ? { ...s, rowId: newRow.id, sectionId: targetSectionId } : s,
      ),
    },
  };
}

/** Moves a whole row (and its seats) to another block, renaming it on label conflicts. */
function moveWholeRow(doc: Doc, rowId: string, targetSectionId: string): Doc {
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row || row.sectionId === targetSectionId) return doc;
  const label = uniqueRowLabel(doc, targetSectionId, row.label, rowId);
  return {
    ...doc,
    rows: doc.rows.map((r) => (r.id === rowId ? { ...r, sectionId: targetSectionId, label } : r)),
    seats: doc.seats.map((s) => (s.rowId === rowId ? { ...s, sectionId: targetSectionId } : s)),
  };
}

/**
 * Moves the selected seats of one row into a new row of the target block. The new row
 * follows the exact part of the original curve; the original row shrinks to the span of its
 * remaining seats.
 */
function extractFromRow(
  doc: Doc,
  rowId: string,
  seatIds: ReadonlySet<string>,
  targetSectionId: string,
): Doc {
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row) return doc;
  const seats = rowSeatsInOrder(doc, rowId);
  const moving = seats.filter((s) => seatIds.has(s.id));
  const staying = seats.filter((s) => !seatIds.has(s.id));
  if (moving.length === 0) return doc;
  if (staying.length === 0) return moveWholeRow(doc, rowId, targetSectionId);
  const curve = row.geometry.curve;
  const t = (s: DocSeat) => curveParameterOf(curve, s);
  const { labelStart, labelEnd, ...base } = row.geometry;
  const newRow: DocRow = {
    id: uid(),
    sectionId: targetSectionId,
    label: uniqueRowLabel(doc, targetSectionId, row.label),
    sortOrder: row.sortOrder,
    geometry: { ...base, curve: subCurve(curve, t(moving[0]!), t(moving[moving.length - 1]!)) },
  };
  const startKept = staying[0] === seats[0];
  const endKept = staying[staying.length - 1] === seats[seats.length - 1];
  const remaining = {
    ...base,
    curve: subCurve(curve, t(staying[0]!), t(staying[staying.length - 1]!)),
    ...(labelStart && startKept ? { labelStart } : {}),
    ...(labelEnd && endKept ? { labelEnd } : {}),
  };
  const movingIds = new Set(moving.map((s) => s.id));
  return {
    ...doc,
    rows: [...doc.rows.map((r) => (r.id === rowId ? { ...r, geometry: remaining } : r)), newRow],
    seats: doc.seats.map((s) =>
      movingIds.has(s.id) ? { ...s, rowId: newRow.id, sectionId: targetSectionId } : s,
    ),
  };
}

/**
 * Re-assigns selected rows and seats to another SEATED block. Selected rows move as a whole
 * (renamed on label conflicts); partially selected rows are split and the selected part
 * becomes a new row in the target block; table / loose seats only change their block.
 */
export function moveToSection(doc: Doc, sel: Selection, targetSectionId: string): Doc {
  const target = doc.sections.find((s) => s.id === targetSectionId);
  if (!target || target.type !== 'SEATED') return doc;
  let next = doc;
  for (const rowId of sel.rows) next = moveWholeRow(next, rowId, targetSectionId);

  const byRow = new Map<string, Set<string>>();
  const loose = new Set<string>();
  for (const seat of next.seats) {
    if (!sel.seats.has(seat.id) || seat.sectionId === targetSectionId) continue;
    if (seat.rowId) {
      if (sel.rows.has(seat.rowId)) continue;
      const set = byRow.get(seat.rowId) ?? new Set<string>();
      set.add(seat.id);
      byRow.set(seat.rowId, set);
    } else {
      loose.add(seat.id);
    }
  }
  for (const [rowId, ids] of byRow) next = extractFromRow(next, rowId, ids, targetSectionId);
  if (loose.size > 0) {
    next = patchSeats(next, loose, (s) => ({ ...s, sectionId: targetSectionId }));
    const after = next;
    // A table whose seats now all belong to the target block follows them.
    const tables = new Set(
      after.seats.filter((s) => loose.has(s.id) && s.tableElementId).map((s) => s.tableElementId!),
    );
    next = {
      ...after,
      elements: after.elements.map((e) =>
        tables.has(e.id) &&
        after.seats
          .filter((s) => s.tableElementId === e.id)
          .every((s) => s.sectionId === targetSectionId)
          ? { ...e, sectionId: targetSectionId }
          : e,
      ),
    };
  }
  return next;
}

/** Removes explicit label positions (labels return next to the first / last seat). */
export function resetRowLabels(doc: Doc, rowIds: ReadonlySet<string>): Doc {
  let changed = false;
  const rows = doc.rows.map((r) => {
    if (!rowIds.has(r.id) || (!r.geometry.labelStart && !r.geometry.labelEnd)) return r;
    changed = true;
    const { labelStart: _start, labelEnd: _end, ...geometry } = r.geometry;
    return { ...r, geometry };
  });
  return changed ? { ...doc, rows } : doc;
}

/**
 * Puts the left labels of all given rows on one vertical line (the leftmost x) and the right
 * labels on another (the rightmost x) – e.g. for staggered rows whose labels would otherwise
 * jump left and right. Every label keeps its own height.
 */
export function alignRowLabels(doc: Doc, rowIds: ReadonlySet<string>): Doc {
  const rows = doc.rows.filter((r) => rowIds.has(r.id));
  if (rows.length < 2) return doc;
  const radius = doc.settings.seatRadius;
  const anchors = rows.map((r) => {
    const { start, end } = rowLabelPoints(r.geometry, radius, rowSeatEnds(doc, r.id));
    return { row: r, start, end, startIsLeft: start.x <= end.x };
  });
  const leftX = round2(Math.min(...anchors.map((a) => (a.startIsLeft ? a.start.x : a.end.x))));
  const rightX = round2(Math.max(...anchors.map((a) => (a.startIsLeft ? a.end.x : a.start.x))));
  const updated = new Map<string, DocRow>(
    anchors.map((a) => [
      a.row.id,
      {
        ...a.row,
        geometry: {
          ...a.row.geometry,
          labelStart: { x: a.startIsLeft ? leftX : rightX, y: round2(a.start.y) },
          labelEnd: { x: a.startIsLeft ? rightX : leftX, y: round2(a.end.y) },
        },
      },
    ]),
  );
  return { ...doc, rows: doc.rows.map((r) => updated.get(r.id) ?? r) };
}

/** Sets one explicit row label position (dragging a label handle). */
export function moveRowLabel(doc: Doc, rowId: string, which: 'start' | 'end', p: Point): Doc {
  const row = doc.rows.find((r) => r.id === rowId);
  if (!row) return doc;
  const point = { x: round2(p.x), y: round2(p.y) };
  return patchEntity(doc, 'rows', rowId, {
    geometry: { ...row.geometry, [which === 'start' ? 'labelStart' : 'labelEnd']: point },
  });
}

// ─── Seat orientation ───────────────────────────────────────────────────────

/** Same orientation (undefined = follow the row). */
export function sameOrientation(
  a: SeatOrientation | undefined,
  b: SeatOrientation | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.mode === b.mode && a.angle === b.angle;
}

/**
 * Sets the seat orientation of rows and turns their seats accordingly (positions stay).
 * `null` lets the seats follow the row again (perpendicular to the curve).
 */
export function setSeatOrientation(
  doc: Doc,
  rowIds: ReadonlySet<string>,
  orientation: SeatOrientation | null,
): Doc {
  const curves = new Map<string, DocRow['geometry']['curve']>();
  const rows = doc.rows.map((r) => {
    if (!rowIds.has(r.id)) return r;
    curves.set(r.id, r.geometry.curve);
    const { seatOrientation: _previous, ...rest } = r.geometry;
    return { ...r, geometry: orientation ? { ...rest, seatOrientation: orientation } : rest };
  });
  const seats = doc.seats.map((seat) => {
    const curve = seat.rowId ? curves.get(seat.rowId) : undefined;
    if (!curve) return seat;
    const rotation = orientSeat(tangentAngleNear(curve, seat), orientation);
    return rotation === seat.rotation ? seat : { ...seat, rotation };
  });
  return { ...doc, rows, seats };
}
