import type { SeatMapElementType } from '../enums';
import type {
  ElementGeometry,
  ElementStyle,
  Point,
  SpecialSeatLabelInput,
} from '../schemas/seat-map';
import { pointsBounds } from './geometry';

/**
 * Appearance of plan elements and entrances – ONE source of truth for the admin editor
 * (Konva) and the public seating chart (SVG), so both draw the same colours, symbols and
 * text positions. All values are in plan coordinates.
 */

/** Default fill per element type (admins override via `style.fill`). */
const DEFAULT_FILL: Partial<Record<SeatMapElementType, string>> = {
  STAGE: '#334155',
  TABLE: '#e2e8f0',
  SHAPE: '#e2e8f0',
  EXIT: '#16a34a',
  FACILITY: '#0ea5e9',
};

/** Default outline per element type (admins override via `style.stroke`). */
const DEFAULT_STROKE: Partial<Record<SeatMapElementType, string>> = {
  STAGE: '#1e293b',
  TABLE: '#94a3b8',
  SHAPE: '#94a3b8',
  LINE: '#64748b',
  IMAGE: '#94a3b8',
};

/** Neutral text / symbol colour on the plan background. */
const NEUTRAL_TEXT = '#334155';

/** Edge length of point markers (EXIT / FACILITY without symbol) and point symbols. */
export const POINT_MARKER_SIZE = 28;

export const ENTRANCE_COLOR = '#16a34a';

/** Black or white text, whichever reads better on `hex`. */
export function contrastText(hex: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m) return '#111827';
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111827' : '#ffffff';
}

export interface ElementLayout {
  /** Shape fill (null = unfilled) and outline. */
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  textColor: string;
  symbolColor: string;
  fontSize: number;
  bold: boolean;
  /** Label to draw (null = none). */
  label: string | null;
  /** Visual centre (rotation-aware); null for free-form paths. */
  center: Point | null;
  /** Symbol box (centre + edge length) when the element has a symbol. */
  symbol: { cx: number; cy: number; size: number } | null;
  /** Badge for point markers without symbol (EXIT / FACILITY). */
  marker: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    cornerRadius: number;
    rotation: number;
    fill: string;
    text: string;
    textColor: string;
    fontSize: number;
  } | null;
  /** Centre of the label (draw horizontally centred, vertically "central"). */
  text: { cx: number; cy: number } | null;
  /** Rotation of symbol + label around the centre (free text elements only). */
  contentRotation: number;
}

/** Centre of an element: true centre also for rotated rectangles (rotation about x/y). */
export function elementCenter(g: ElementGeometry): Point | null {
  switch (g.type) {
    case 'rect': {
      const rad = (g.rotation * Math.PI) / 180;
      const hx = g.width / 2;
      const hy = g.height / 2;
      return {
        x: g.x + hx * Math.cos(rad) - hy * Math.sin(rad),
        y: g.y + hx * Math.sin(rad) + hy * Math.cos(rad),
      };
    }
    case 'ellipse':
      return { x: g.cx, y: g.cy };
    case 'point':
      return { x: g.x, y: g.y };
    case 'polygon':
    case 'polyline': {
      const b = pointsBounds(g.points);
      return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    }
    case 'path':
      return null;
  }
}

/** Default symbol size derived from the element's extent. */
function defaultSymbolSize(g: ElementGeometry): number {
  switch (g.type) {
    case 'rect':
      return Math.max(12, Math.min(g.width, g.height) * 0.55);
    case 'ellipse':
      return Math.max(12, Math.min(g.rx, g.ry) * 1.1);
    case 'polygon':
    case 'polyline': {
      const b = pointsBounds(g.points);
      return Math.max(16, Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.55);
    }
    default:
      return POINT_MARKER_SIZE;
  }
}

export function elementLayout(element: {
  type: SeatMapElementType;
  geometry: ElementGeometry;
  label: string | null;
  style: ElementStyle;
}): ElementLayout {
  const { type, geometry: g, style } = element;
  const isPoint = g.type === 'point';
  const isLine = type === 'LINE' || g.type === 'polyline';
  const shapeFill =
    isPoint || isLine || type === 'TEXT' ? null : (style.fill ?? DEFAULT_FILL[type] ?? null);
  const stroke = isPoint ? null : (style.stroke ?? DEFAULT_STROKE[type] ?? null);
  const strokeWidth = style.strokeWidth ?? (isLine ? 2 : 1.5);
  const onFill = shapeFill ? contrastText(shapeFill) : type === 'TEXT' ? '#111827' : NEUTRAL_TEXT;
  const textColor = style.textColor ?? onFill;
  const symbolColor = style.symbolColor ?? style.textColor ?? onFill;
  const fontSize = style.fontSize ?? (type === 'STAGE' ? 22 : isPoint && type !== 'TEXT' ? 12 : 14);
  const bold = style.fontWeight ? style.fontWeight === 'bold' : type === 'STAGE';
  const center = elementCenter(g);
  const label = element.label?.trim() ? element.label.trim() : null;
  const contentRotation = g.type === 'point' && type === 'TEXT' ? g.rotation : 0;
  const base = {
    fill: shapeFill,
    stroke,
    strokeWidth,
    textColor,
    symbolColor,
    fontSize,
    bold,
    center,
    contentRotation,
  };

  if (!center || g.type === 'path') {
    return { ...base, label: null, symbol: null, marker: null, text: null };
  }
  const symbolSize = style.symbolSize ?? defaultSymbolSize(g);
  const hasSymbol = Boolean(style.symbolId);
  const gap = fontSize * 0.35;

  // Point markers (exit sign / facility) without a symbol: badge + label below.
  if (isPoint && !hasSymbol && (type === 'EXIT' || type === 'FACILITY')) {
    const markerFill = style.fill ?? DEFAULT_FILL[type]!;
    const text = style.icon ?? (type === 'EXIT' ? 'EXIT' : 'i');
    const height = POINT_MARKER_SIZE;
    const width = type === 'EXIT' || text.length > 2 ? POINT_MARKER_SIZE * 1.8 : POINT_MARKER_SIZE;
    const marker = {
      cx: center.x,
      cy: center.y,
      width,
      height,
      cornerRadius: POINT_MARKER_SIZE * 0.25,
      rotation: g.rotation,
      fill: markerFill,
      text,
      textColor: contrastText(markerFill),
      fontSize: text.length > 2 ? 10 : 14,
    };
    const showLabel = label !== null && label.toUpperCase() !== text.toUpperCase();
    return {
      ...base,
      textColor: style.textColor ?? NEUTRAL_TEXT,
      label: showLabel ? label : null,
      symbol: null,
      marker,
      text: showLabel ? { cx: center.x, cy: center.y + height / 2 + gap + fontSize / 2 } : null,
    };
  }

  // Point elements with a symbol (facility icons …): symbol on the point, label below.
  if (isPoint && type !== 'TEXT') {
    return {
      ...base,
      label,
      symbol: hasSymbol ? { cx: center.x, cy: center.y, size: symbolSize } : null,
      marker: null,
      text: label
        ? { cx: center.x, cy: center.y + (hasSymbol ? symbolSize / 2 + gap + fontSize / 2 : 0) }
        : null,
    };
  }

  // Shapes and text: symbol and label stacked and centred as one group.
  const total =
    (hasSymbol ? symbolSize : 0) + (hasSymbol && label ? gap : 0) + (label ? fontSize : 0);
  const top = center.y - total / 2;
  return {
    ...base,
    label,
    symbol: hasSymbol ? { cx: center.x, cy: top + symbolSize / 2, size: symbolSize } : null,
    marker: null,
    text: label
      ? { cx: center.x, cy: top + (hasSymbol ? symbolSize + gap : 0) + fontSize / 2 }
      : null,
  };
}

/** Entrance marker: green rounded badge with the entrance code, name below. */
export function entranceLayout(
  entrance: { x: number; y: number; code: string; name: string },
  seatRadius: number,
) {
  const half = Math.max(10, seatRadius * 1.6);
  const codeFontSize = entrance.code.length > 2 ? half * 0.75 : half * 1.05;
  const nameFontSize = Math.max(9, half * 0.75);
  return {
    color: ENTRANCE_COLOR,
    badge: {
      x: entrance.x - half,
      y: entrance.y - half,
      size: half * 2,
      cornerRadius: half * 0.35,
    },
    code: { cx: entrance.x, cy: entrance.y, fontSize: codeFontSize },
    name: { cx: entrance.x, cy: entrance.y + half + 4 + nameFontSize / 2, fontSize: nameFontSize },
  };
}

/** Default icons of special seats (also used by the editor). */
export const SPECIAL_SEAT_ICONS = { wheelchair: '♿', companion: '+' } as const;

/**
 * Text drawn on a seat in the plan. Normal seats show their number; wheelchair spaces and
 * companion seats follow the plan setting (icon, number, custom short text or nothing).
 * `kind` lets renderers show markers earlier (less zoom) than seat numbers.
 */
export function seatPlanLabel(
  seat: { label: string; isWheelchairSpace: boolean; isCompanionSeat: boolean },
  settings: { wheelchairLabel?: SpecialSeatLabelInput; companionLabel?: SpecialSeatLabelInput },
): { text: string; kind: 'NUMBER' | 'MARKER' } | null {
  const special = seat.isWheelchairSpace ? 'wheelchair' : seat.isCompanionSeat ? 'companion' : null;
  if (!special) return { text: seat.label, kind: 'NUMBER' };
  const config = (special === 'wheelchair'
    ? settings.wheelchairLabel
    : settings.companionLabel) ?? {
    mode: 'ICON',
  };
  switch (config.mode ?? 'ICON') {
    case 'NONE':
      return null;
    case 'NUMBER':
      return { text: seat.label, kind: 'NUMBER' };
    case 'TEXT':
      return config.text ? { text: config.text, kind: 'MARKER' } : null;
    default:
      return { text: SPECIAL_SEAT_ICONS[special], kind: 'MARKER' };
  }
}
