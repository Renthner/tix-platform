import type { Point, RowGeometry, SeatOrientation, SectionGeometry } from '../schemas/seat-map';

/** Pure geometry helpers shared by the editor (layout) and the public chart (rendering). */

type Curve = RowGeometry['curve'];

export function quadraticPoint(p0: Point, c: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

function pointAt(curve: Curve, t: number): Point {
  if (curve.type === 'straight') {
    return {
      x: curve.start.x + (curve.end.x - curve.start.x) * t,
      y: curve.start.y + (curve.end.y - curve.start.y) * t,
    };
  }
  return quadraticPoint(curve.start, curve.control, curve.end, t);
}

/** Tangent angle (degrees) of the curve at parameter t. */
function angleAt(curve: Curve, t: number): number {
  const d = 1e-4;
  const a = pointAt(curve, Math.max(0, t - d));
  const b = pointAt(curve, Math.min(1, t + d));
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

const SAMPLES = 256;

function arcTable(curve: Curve): { t: number[]; len: number[] } {
  const t: number[] = [0];
  const len: number[] = [0];
  let prev = pointAt(curve, 0);
  for (let i = 1; i <= SAMPLES; i += 1) {
    const ti = i / SAMPLES;
    const p = pointAt(curve, ti);
    t.push(ti);
    len.push(len[i - 1]! + Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  return { t, len };
}

export function curveLength(curve: Curve): number {
  const { len } = arcTable(curve);
  return len[len.length - 1]!;
}

export interface PlacedSeat {
  x: number;
  y: number;
  /** Rotation in degrees so the seat faces "forward" (perpendicular to the row). */
  rotation: number;
}

/**
 * Distributes `count` seats with equal arc-length spacing from the start to the end of the
 * row curve (first seat on `start`, last seat on `end`).
 */
export function layoutRowSeats(
  curve: Curve,
  count: number,
  orientation?: SeatOrientation | null,
): PlacedSeat[] {
  if (!Number.isInteger(count) || count < 1) return [];
  const { t, len } = arcTable(curve);
  const total = len[len.length - 1]!;
  const seats: PlacedSeat[] = [];
  for (let i = 0; i < count; i += 1) {
    const target = count === 1 ? total / 2 : (total * i) / (count - 1);
    let j = 1;
    while (j < len.length - 1 && len[j]! < target) j += 1;
    const l0 = len[j - 1]!;
    const l1 = len[j]!;
    const f = l1 === l0 ? 0 : (target - l0) / (l1 - l0);
    const ti = t[j - 1]! + (t[j]! - t[j - 1]!) * f;
    const p = pointAt(curve, ti);
    seats.push({
      x: round2(p.x),
      y: round2(p.y),
      rotation: orientSeat(angleAt(curve, ti), orientation),
    });
  }
  return seats;
}

/** Angle normalised to (-180, 180], rounded to 2 decimals. */
export function normalizeAngle(angle: number): number {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return round2(a);
}

/**
 * Seat rotation (degrees, 0 = facing up) from the row tangent at the seat and the row's
 * orientation setting (see `seatOrientationSchema`).
 */
export function orientSeat(tangent: number, orientation?: SeatOrientation | null): number {
  if (!orientation) return normalizeAngle(tangent);
  return normalizeAngle(
    orientation.mode === 'FIXED' ? orientation.angle : tangent + orientation.angle,
  );
}

/** Tangent angle of the curve at the point of the curve closest to `p`. */
export function tangentAngleNear(curve: Curve, p: Point): number {
  if (curve.type === 'straight') return angleAt(curve, 0.5);
  const distance = (t: number) => {
    const q = pointAt(curve, t);
    return (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  };
  // Coarse scan, then refine around the best sample (precision ≈ 1 / 65 536 of the curve).
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= SAMPLES; i += 1) {
    const d = distance(i / SAMPLES);
    if (d < bestDistance) [best, bestDistance] = [i / SAMPLES, d];
  }
  const from = Math.max(0, best - 1 / SAMPLES);
  const to = Math.min(1, best + 1 / SAMPLES);
  for (let i = 0; i <= 512; i += 1) {
    const t = from + ((to - from) * i) / 512;
    const d = distance(t);
    if (d < bestDistance) [best, bestDistance] = [t, d];
  }
  return angleAt(curve, best);
}

/**
 * Default positions of a row's labels: `offset` before the first and after the last seat,
 * along the row direction (curve tangent at those seats). Shared by editor and shop so both
 * show the labels at the same place. Works for single-seat rows and rows whose curve has
 * no length (labels then sit left and right of the seat).
 */
export function rowLabelAnchors(
  curve: Curve,
  offset: number,
  ends?: { first: Point; last: Point } | null,
): { start: Point; end: Point } {
  const first = ends?.first ?? curve.start;
  const last = ends?.last ?? curve.end;
  let dirStart: Point;
  let dirEnd: Point;
  if (curveLength(curve) > 1e-6) {
    dirStart = unitFromAngle(tangentAngleNear(curve, first));
    dirEnd = unitFromAngle(tangentAngleNear(curve, last));
  } else {
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const len = Math.hypot(dx, dy);
    dirStart = dirEnd = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  }
  return {
    start: { x: round2(first.x - dirStart.x * offset), y: round2(first.y - dirStart.y * offset) },
    end: { x: round2(last.x + dirEnd.x * offset), y: round2(last.y + dirEnd.y * offset) },
  };
}

function unitFromAngle(degrees: number): Point {
  const rad = (degrees * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** Distance of default row labels from the first / last seat, in seat radii. */
export const ROW_LABEL_OFFSET = 2.4;

/** Seats needed to fill a curve with the given spacing (inclusive of both ends). */
export function seatCountForSpacing(curve: Curve, spacing: number): number {
  if (spacing <= 0) return 0;
  return Math.floor(curveLength(curve) / spacing) + 1;
}

/**
 * Seat numbers for `count` seats ordered left → right (by position).
 *  - ASCENDING: 1 … n
 *  - DESCENDING: n … 1
 *  - ODD_EVEN_FROM_CENTER: odd numbers from the centre to the left, even to the right
 *    (common in European theatres).
 */
export function seatNumbers(
  count: number,
  numbering: RowGeometry['numbering'],
  start = 1,
): string[] {
  if (count < 1) return [];
  if (numbering === 'ASCENDING') return Array.from({ length: count }, (_, i) => String(start + i));
  if (numbering === 'DESCENDING') {
    return Array.from({ length: count }, (_, i) => String(start + count - 1 - i));
  }
  const labels = new Array<string>(count);
  const mid = Math.floor((count - 1) / 2);
  let odd = 1;
  for (let i = mid; i >= 0; i -= 1, odd += 2) labels[i] = String(odd + start - 1);
  let even = 2;
  for (let i = mid + 1; i < count; i += 1, even += 2) labels[i] = String(even + start - 1);
  return labels;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function sectionBounds(geometry: SectionGeometry): Bounds | null {
  switch (geometry.type) {
    case 'polygon':
      return pointsBounds(geometry.points);
    case 'rect':
      return rotatedRectBounds(
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
        geometry.rotation,
      );
    case 'ellipse':
      return {
        minX: geometry.cx - geometry.rx,
        minY: geometry.cy - geometry.ry,
        maxX: geometry.cx + geometry.rx,
        maxY: geometry.cy + geometry.ry,
      };
    case 'path':
      return null;
  }
}

export function pointsBounds(points: Point[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function rotatedRectBounds(x: number, y: number, w: number, h: number, rotation: number): Bounds {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((c) => ({ x: x + c.x * cos - c.y * sin, y: y + c.x * sin + c.y * cos }));
  return pointsBounds(corners);
}

/** Area-weighted centroid of a simple polygon (falls back to the vertex mean). */
export function polygonCentroid(points: Point[]): Point {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const n = points.length || 1;
    return {
      x: points.reduce((s, p) => s + p.x, 0) / n,
      y: points.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  area /= 2;
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
