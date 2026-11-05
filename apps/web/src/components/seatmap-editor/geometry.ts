import {
  ROW_LABEL_OFFSET,
  rowLabelAnchors,
  pointInPolygon,
  pointsBounds,
  polygonCentroid,
  quadraticPoint,
  sectionBounds,
  type Bounds,
  type DocSection,
  type ElementGeometry,
  type Point,
  type RowGeometry,
  type SeatMapSettings,
  type SectionGeometry,
  type SectionLabel,
} from '@tix/shared';
import type { Doc } from './model';

/** Editor-only geometry: snapping, translation, hit testing, bounds. */

type Curve = RowGeometry['curve'];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function snapValue(v: number, settings: SeatMapSettings): number {
  return settings.snapToGrid && settings.gridSize > 0
    ? Math.round(v / settings.gridSize) * settings.gridSize
    : round2(v);
}

export function snapPoint(p: Point, settings: SeatMapSettings): Point {
  return { x: snapValue(p.x, settings), y: snapValue(p.y, settings) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ─── Curves ─────────────────────────────────────────────────────────────────

export function curvePoint(curve: Curve, t: number): Point {
  if (curve.type === 'straight') {
    return {
      x: curve.start.x + (curve.end.x - curve.start.x) * t,
      y: curve.start.y + (curve.end.y - curve.start.y) * t,
    };
  }
  return quadraticPoint(curve.start, curve.control, curve.end, t);
}

export function sampleCurve(curve: Curve, segments = 24): Point[] {
  if (curve.type === 'straight') return [curve.start, curve.end];
  return Array.from({ length: segments + 1 }, (_, i) => curvePoint(curve, i / segments));
}

/** Unit tangent of the curve at parameter t. */
export function curveTangent(curve: Curve, t: number): Point {
  const a = curvePoint(curve, Math.max(0, t - 0.01));
  const b = curvePoint(curve, Math.min(1, t + 0.01));
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

/** Default control point making a gentle arc bulging "down" (towards the audience). */
export function defaultArcControl(start: Point, end: Point, bulge: number): Point {
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: round2(mid.x - (dy / len) * bulge), y: round2(mid.y + (dx / len) * bulge) };
}

// ─── Translation ────────────────────────────────────────────────────────────

const tp = (p: Point, dx: number, dy: number): Point => ({
  x: round2(p.x + dx),
  y: round2(p.y + dy),
});

export function translateSectionGeometry(
  g: SectionGeometry,
  dx: number,
  dy: number,
): SectionGeometry {
  switch (g.type) {
    case 'polygon':
      return { ...g, points: g.points.map((p) => tp(p, dx, dy)) };
    case 'rect':
      return { ...g, x: round2(g.x + dx), y: round2(g.y + dy) };
    case 'ellipse':
      return { ...g, cx: round2(g.cx + dx), cy: round2(g.cy + dy) };
    case 'path':
      // Imported SVG paths are not re-written; they keep their absolute coordinates.
      return g;
  }
}

export function translateElementGeometry(
  g: ElementGeometry,
  dx: number,
  dy: number,
): ElementGeometry {
  switch (g.type) {
    case 'rect':
    case 'point':
      return { ...g, x: round2(g.x + dx), y: round2(g.y + dy) };
    case 'ellipse':
      return { ...g, cx: round2(g.cx + dx), cy: round2(g.cy + dy) };
    case 'polygon':
    case 'polyline':
      return { ...g, points: g.points.map((p) => tp(p, dx, dy)) };
    case 'path':
      return g;
  }
}

export function translateCurve(curve: Curve, dx: number, dy: number): Curve {
  return curve.type === 'straight'
    ? { type: 'straight', start: tp(curve.start, dx, dy), end: tp(curve.end, dx, dy) }
    : {
        type: 'arc',
        start: tp(curve.start, dx, dy),
        end: tp(curve.end, dx, dy),
        control: tp(curve.control, dx, dy),
      };
}

export function translateLabel(
  label: SectionLabel | null,
  dx: number,
  dy: number,
): SectionLabel | null {
  return label ? { ...label, position: tp(label.position, dx, dy) } : null;
}

// ─── Hit testing ────────────────────────────────────────────────────────────

function inverseRotate(p: Point, origin: Point, degrees: number): Point {
  if (!degrees) return p;
  const rad = (-degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = p.x - origin.x;
  const y = p.y - origin.y;
  return { x: origin.x + x * cos - y * sin, y: origin.y + x * sin + y * cos };
}

export function sectionContains(g: SectionGeometry, p: Point): boolean {
  switch (g.type) {
    case 'polygon':
      return pointInPolygon(p, g.points);
    case 'rect': {
      const q = inverseRotate(p, { x: g.x, y: g.y }, g.rotation);
      return q.x >= g.x && q.x <= g.x + g.width && q.y >= g.y && q.y <= g.y + g.height;
    }
    case 'ellipse': {
      const q = inverseRotate(p, { x: g.cx, y: g.cy }, g.rotation);
      return ((q.x - g.cx) / g.rx) ** 2 + ((q.y - g.cy) / g.ry) ** 2 <= 1;
    }
    case 'path': {
      return false;
    }
  }
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolyline(p: Point, points: Point[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1)
    best = Math.min(best, distanceToSegment(p, points[i - 1]!, points[i]!));
  return best;
}

/** Rect / ellipse element geometry viewed as the equivalent section shape. */
function asSectionShape(
  g: Extract<ElementGeometry, { type: 'rect' | 'ellipse' }>,
): SectionGeometry {
  return g.type === 'rect'
    ? { type: 'rect', x: g.x, y: g.y, width: g.width, height: g.height, rotation: g.rotation }
    : { type: 'ellipse', cx: g.cx, cy: g.cy, rx: g.rx, ry: g.ry, rotation: g.rotation };
}

/** Visual radius of point-like elements (exit / facility / text anchors) in world units. */
export const POINT_ELEMENT_SIZE = 14;

export function elementBounds(g: ElementGeometry): Bounds | null {
  switch (g.type) {
    case 'rect':
    case 'ellipse':
      return sectionBounds(asSectionShape(g));
    case 'polygon':
    case 'polyline':
      return pointsBounds(g.points);
    case 'point':
      return {
        minX: g.x - POINT_ELEMENT_SIZE,
        minY: g.y - POINT_ELEMENT_SIZE,
        maxX: g.x + POINT_ELEMENT_SIZE,
        maxY: g.y + POINT_ELEMENT_SIZE,
      };
    case 'path':
      return null;
  }
}

export function elementContains(g: ElementGeometry, p: Point, tolerance: number): boolean {
  switch (g.type) {
    case 'rect':
    case 'ellipse':
      return sectionContains(asSectionShape(g), p);
    case 'polygon':
      return pointInPolygon(p, g.points);
    case 'polyline':
      return distanceToPolyline(p, g.points) <= tolerance;
    case 'point':
      return distance(p, g) <= POINT_ELEMENT_SIZE + tolerance;
    case 'path':
      return false;
  }
}

// ─── Bounds ─────────────────────────────────────────────────────────────────

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function boundsCenter(b: Bounds): Point {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export function rectFromPoints(
  a: Point,
  b: Point,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function pointInBounds(p: Point, b: Bounds): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/** Anchor for a section's label: explicit label position, else the shape's centre. */
export function sectionCenter(section: DocSection): Point {
  if (section.label) return section.label.position;
  if (section.geometry.type === 'polygon') return polygonCentroid(section.geometry.points);
  const b = sectionBounds(section.geometry);
  return b ? boundsCenter(b) : { x: 0, y: 0 };
}

export function docContentBounds(doc: Doc): Bounds | null {
  let bounds: Bounds | null = null;
  const r = doc.settings.seatRadius;
  for (const s of doc.seats) {
    bounds = unionBounds(bounds, { minX: s.x - r, minY: s.y - r, maxX: s.x + r, maxY: s.y + r });
  }
  for (const s of doc.sections) bounds = unionBounds(bounds, sectionBounds(s.geometry));
  for (const e of doc.elements) bounds = unionBounds(bounds, elementBounds(e.geometry));
  for (const e of doc.entrances) {
    bounds = unionBounds(bounds, {
      minX: e.x - 20,
      minY: e.y - 20,
      maxX: e.x + 20,
      maxY: e.y + 20,
    });
  }
  return bounds;
}

/** Topmost section of the given type whose shape contains the point. */
export function sectionAt(doc: Doc, p: Point, type?: DocSection['type']): DocSection | null {
  for (let i = doc.sections.length - 1; i >= 0; i -= 1) {
    const s = doc.sections[i]!;
    if (type && s.type !== type) continue;
    if (sectionContains(s.geometry, p)) return s;
  }
  return null;
}

/** World positions of a row's start / end labels (outside the first / last seat). */
/** Black or white text for a fill colour (shared with the public chart). */
export { contrastText } from '@tix/shared';

// ─── Row geometry: labels, sub-curves, projection ───────────────────────────

export function translateRowGeometry(g: RowGeometry, dx: number, dy: number): RowGeometry {
  return {
    ...g,
    curve: translateCurve(g.curve, dx, dy),
    ...(g.labelStart ? { labelStart: tp(g.labelStart, dx, dy) } : {}),
    ...(g.labelEnd ? { labelEnd: tp(g.labelEnd, dx, dy) } : {}),
  };
}

/**
 * Effective label positions: explicit ones from the geometry, else next to the end seats
 * (`ends` = first / last seat of the row; falls back to the curve ends). Same rule as the
 * public seating chart.
 */
export function rowLabelPoints(
  g: RowGeometry,
  seatRadius: number,
  ends?: { first: Point; last: Point } | null,
): { start: Point; end: Point } {
  const defaults = rowLabelAnchors(g.curve, seatRadius * ROW_LABEL_OFFSET, ends);
  return { start: g.labelStart ?? defaults.start, end: g.labelEnd ?? defaults.end };
}

/** First and last seat (by position) of a row, or null for an empty row. */
export function rowSeatEnds(doc: Doc, rowId: string): { first: Point; last: Point } | null {
  let first: Doc['seats'][number] | null = null;
  let last: Doc['seats'][number] | null = null;
  for (const seat of doc.seats) {
    if (seat.rowId !== rowId) continue;
    const p = seat.position ?? 0;
    if (!first || p < (first.position ?? 0)) first = seat;
    if (!last || p > (last.position ?? 0)) last = seat;
  }
  return first && last ? { first, last } : null;
}

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/**
 * Exact part [t0, t1] of a row curve. Quadratic Béziers are subdivided with de Casteljau,
 * so the parts keep exactly the curvature of the original row.
 */
export function subCurve(curve: Curve, t0: number, t1: number): Curve {
  const a = Math.max(0, Math.min(1, Math.min(t0, t1)));
  const b = Math.max(0, Math.min(1, Math.max(t0, t1)));
  if (curve.type === 'straight') {
    const start = lerp(curve.start, curve.end, a);
    const end = lerp(curve.start, curve.end, b);
    return { type: 'straight', start: tp(start, 0, 0), end: tp(end, 0, 0) };
  }
  // Left part [0, b]: P0, lerp(P0, C, b), B(b)
  const c1 = lerp(curve.start, curve.control, b);
  const e1 = quadraticPoint(curve.start, curve.control, curve.end, b);
  // Right part of that curve from s = a / b
  const s = b === 0 ? 0 : a / b;
  const start = quadraticPoint(curve.start, c1, e1, s);
  const control = lerp(c1, e1, s);
  return { type: 'arc', start: tp(start, 0, 0), end: tp(e1, 0, 0), control: tp(control, 0, 0) };
}

/** Curve parameter t ∈ [0, 1] of the point on the curve closest to p. */
export function curveParameterOf(curve: Curve, p: Point): number {
  if (curve.type === 'straight') {
    const dx = curve.end.x - curve.start.x;
    const dy = curve.end.y - curve.start.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return 0;
    return Math.max(
      0,
      Math.min(1, ((p.x - curve.start.x) * dx + (p.y - curve.start.y) * dy) / len2),
    );
  }
  const steps = 200;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i <= steps; i += 1) {
    const d = distance(curvePoint(curve, i / steps), p);
    if (d < bestDist) {
      bestDist = d;
      best = i / steps;
    }
  }
  // Refine around the coarse optimum.
  let lo = Math.max(0, best - 1 / steps);
  let hi = Math.min(1, best + 1 / steps);
  for (let i = 0; i < 30; i += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (distance(curvePoint(curve, m1), p) < distance(curvePoint(curve, m2), p)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}
