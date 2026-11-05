'use client';

import type {
  DocElement,
  DocEntrance,
  DocRow,
  DocSeat,
  DocSection,
  ElementGeometry,
  Point,
  SeatMapSettings,
} from '@tix/shared';
import type Konva from 'konva';
import { elementLayout, entranceLayout, seatPlanLabel } from '@tix/shared';
import { memo, type ReactNode } from 'react';
import { Ellipse, Group, Image as KonvaImage, Line, Path, Rect, Shape, Text } from 'react-konva';
import {
  contrastText,
  rowLabelPoints,
  sampleCurve,
  sectionCenter,
  translateElementGeometry,
  translateLabel,
  translateRowGeometry,
  translateSectionGeometry,
} from './geometry';
import { COLORS } from './model';
import { getSymbolImage } from './symbols';
import type { EditorSymbol } from './types';

/**
 * Rendering of the editor canvas. Everything here is non-listening: hit testing is done
 * mathematically by the canvas controller, which keeps Konva's event system out of the
 * hot path for plans with many thousands of seats.
 */

const flat = (points: { x: number; y: number }[]) => points.flatMap((p) => [p.x, p.y]);

/** `#RRGGBB` (or `#RRGGBBAA`) with a new alpha channel. */
function withAlpha(hex: string, alpha: number): string {
  const base = hex.length >= 7 ? hex.slice(0, 7) : COLORS.sectionDefault;
  return `${base}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/** Visible world rectangle of a shape's stage (for culling inside sceneFuncs). */
function visibleWorld(shape: Konva.Shape): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const stage = shape.getStage();
  const inv = shape.getAbsoluteTransform().copy().invert();
  const a = inv.point({ x: 0, y: 0 });
  const b = inv.point({ x: stage?.width() ?? 0, y: stage?.height() ?? 0 });
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

// ─── Background ─────────────────────────────────────────────────────────────

export const CanvasBackground = memo(function CanvasBackground({
  width,
  height,
  settings,
}: {
  width: number;
  height: number;
  settings: SeatMapSettings;
}) {
  return (
    <>
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill={COLORS.canvas}
        stroke={COLORS.canvasBorder}
        strokeScaleEnabled={false}
        strokeWidth={1}
        listening={false}
        perfectDrawEnabled={false}
      />
      {settings.gridSize > 0 && (
        <Shape
          listening={false}
          perfectDrawEnabled={false}
          sceneFunc={(context, shape) => {
            const ctx = context._context;
            const scale = shape.getAbsoluteScale().x || 1;
            let step = settings.gridSize;
            while (step * scale < 8) step *= 2;
            const view = visibleWorld(shape);
            const x0 = Math.max(0, Math.floor(view.minX / step) * step);
            const x1 = Math.min(width, view.maxX);
            const y0 = Math.max(0, Math.floor(view.minY / step) * step);
            const y1 = Math.min(height, view.maxY);
            const top = Math.max(0, view.minY);
            const bottom = Math.min(height, view.maxY);
            const left = Math.max(0, view.minX);
            const right = Math.min(width, view.maxX);
            ctx.lineWidth = 1 / scale;
            for (const major of [false, true]) {
              ctx.beginPath();
              ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
              for (let x = x0; x <= x1; x += step) {
                if ((Math.round(x / step) % 5 === 0) !== major) continue;
                ctx.moveTo(x, top);
                ctx.lineTo(x, bottom);
              }
              for (let y = y0; y <= y1; y += step) {
                if ((Math.round(y / step) % 5 === 0) !== major) continue;
                ctx.moveTo(left, y);
                ctx.lineTo(right, y);
              }
              ctx.stroke();
            }
          }}
        />
      )}
    </>
  );
});

// ─── Sections ───────────────────────────────────────────────────────────────

export const SectionNode = memo(function SectionNode({
  section,
  selected,
  dx,
  dy,
  scale,
  hiddenNameSuffix,
}: {
  section: DocSection;
  selected: boolean;
  dx: number;
  dy: number;
  scale: number;
  /** Appended to the name when it is hidden on the public seating chart. */
  hiddenNameSuffix: string;
}) {
  const geometry = dx || dy ? translateSectionGeometry(section.geometry, dx, dy) : section.geometry;
  const color = section.color ?? COLORS.sectionDefault;
  const common = {
    fill: withAlpha(color, section.isActive ? 0.16 : 0.06),
    stroke: selected ? COLORS.selection : withAlpha(color, 0.8),
    strokeWidth: (selected ? 2.5 : 1.2) / scale,
    dash: section.type === 'STANDING' ? [8 / scale, 5 / scale] : undefined,
    listening: false,
    perfectDrawEnabled: false,
  };
  const label = translateLabel(section.label, dx, dy);
  const center = label?.position ?? sectionCenter({ ...section, geometry, label: null });
  const fontSize = label?.fontSize ?? 16;
  const base =
    section.type === 'STANDING' ? `${section.name} · ${section.capacity ?? 0}` : section.name;
  // Admin view: a name hidden in the shop is still shown, but faint and marked.
  const text = section.showNameOnMap ? base : `${base} ${hiddenNameSuffix}`;
  return (
    <Group listening={false}>
      {geometry.type === 'polygon' && <Line points={flat(geometry.points)} closed {...common} />}
      {geometry.type === 'rect' && (
        <Rect
          x={geometry.x}
          y={geometry.y}
          width={geometry.width}
          height={geometry.height}
          rotation={geometry.rotation}
          {...common}
        />
      )}
      {geometry.type === 'ellipse' && (
        <Ellipse
          x={geometry.cx}
          y={geometry.cy}
          radiusX={geometry.rx}
          radiusY={geometry.ry}
          rotation={geometry.rotation}
          {...common}
        />
      )}
      {geometry.type === 'path' && <Path data={geometry.d} {...common} />}
      <Text
        text={text}
        x={center.x}
        y={center.y}
        width={600}
        offsetX={300}
        offsetY={fontSize / 2}
        rotation={label?.rotation ?? 0}
        align="center"
        fontSize={fontSize}
        fontStyle={section.showNameOnMap ? 'bold' : 'italic'}
        fill={withAlpha(color, section.showNameOnMap ? 0.9 : 0.4)}
        listening={false}
        perfectDrawEnabled={false}
      />
    </Group>
  );
});

// ─── Elements ───────────────────────────────────────────────────────────────

/** Large text box width; texts are centred on their anchor and never wrap. */
const TEXT_BOX = 2000;

/** Centred, non-wrapping Konva text (same anchor rule as the shop's SVG text). */
function CenteredText({
  text,
  x,
  y,
  fontSize,
  bold,
  fill,
}: {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  bold: boolean;
  fill: string;
}) {
  return (
    <Text
      text={text}
      x={x}
      y={y}
      width={TEXT_BOX}
      offsetX={TEXT_BOX / 2}
      offsetY={fontSize / 2}
      align="center"
      wrap="none"
      fontSize={fontSize}
      fontStyle={bold ? 'bold' : 'normal'}
      fill={fill}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}

/**
 * Plan element (stage, table, shape, text, exit sign, facility …). Colours, symbol box,
 * marker and label positions come from `elementLayout` – identical to the public chart.
 */
export const ElementNode = memo(function ElementNode({
  element,
  selected,
  dx,
  dy,
  scale,
  symbol,
  imagesVersion,
}: {
  element: DocElement;
  selected: boolean;
  dx: number;
  dy: number;
  scale: number;
  symbol: EditorSymbol | null;
  /** Re-renders the node when a symbol image finished loading. */
  imagesVersion: number;
}) {
  void imagesVersion;
  const g = dx || dy ? translateElementGeometry(element.geometry, dx, dy) : element.geometry;
  const layout = elementLayout({ ...element, geometry: g });
  const selectionStroke = selected ? COLORS.selection : undefined;
  const shared = {
    fill: layout.fill ?? undefined,
    stroke: selectionStroke ?? layout.stroke ?? undefined,
    strokeWidth: selected ? 2.5 / scale : layout.strokeWidth,
    listening: false,
    perfectDrawEnabled: false,
    dash: element.type === 'IMAGE' ? [6 / scale, 4 / scale] : undefined,
  };

  let shape: ReactNode = null;
  switch (g.type) {
    case 'rect':
      shape = (
        <Rect
          x={g.x}
          y={g.y}
          width={g.width}
          height={g.height}
          rotation={g.rotation}
          cornerRadius={g.cornerRadius}
          {...shared}
        />
      );
      break;
    case 'ellipse':
      shape = (
        <Ellipse
          x={g.cx}
          y={g.cy}
          radiusX={g.rx}
          radiusY={g.ry}
          rotation={g.rotation}
          {...shared}
        />
      );
      break;
    case 'polygon':
      shape = <Line points={flat(g.points)} closed {...shared} />;
      break;
    case 'polyline':
      shape = (
        <Line
          points={flat(g.points)}
          {...shared}
          fill={undefined}
          lineCap="round"
          lineJoin="round"
        />
      );
      break;
    case 'path':
      shape = <Path data={g.d} {...shared} />;
      break;
    case 'point':
      break;
  }

  const image = symbol && layout.symbol ? getSymbolImage(symbol, layout.symbolColor) : null;
  const marker = layout.marker;

  // Selection frame for point elements without a shape (symbol / text / marker).
  let pointFrame: ReactNode = null;
  if (selected && g.type === 'point' && !marker && layout.center) {
    const textHalf = layout.label ? layout.label.length * layout.fontSize * 0.3 : 0;
    const half = Math.max(layout.symbol ? layout.symbol.size / 2 : 0, textHalf, 8);
    const top = layout.symbol
      ? layout.symbol.cy - layout.symbol.size / 2
      : (layout.text?.cy ?? layout.center.y) - layout.fontSize / 2;
    const bottom = layout.text
      ? layout.text.cy + layout.fontSize / 2
      : layout.symbol
        ? layout.symbol.cy + layout.symbol.size / 2
        : layout.center.y + 8;
    const pad = 3 / scale;
    pointFrame = (
      <Rect
        x={layout.center.x - half - pad}
        y={top - pad}
        width={half * 2 + pad * 2}
        height={bottom - top + pad * 2}
        stroke={COLORS.selection}
        strokeWidth={2 / scale}
        dash={[4 / scale, 3 / scale]}
        listening={false}
      />
    );
  }

  const center = layout.center;
  return (
    <Group listening={false} opacity={element.style.opacity ?? 1}>
      {shape}
      {pointFrame}
      <Group
        x={center?.x ?? 0}
        y={center?.y ?? 0}
        offsetX={center?.x ?? 0}
        offsetY={center?.y ?? 0}
        rotation={layout.contentRotation}
        listening={false}
      >
        {image && layout.symbol && (
          <KonvaImage
            image={image}
            x={layout.symbol.cx - layout.symbol.size / 2}
            y={layout.symbol.cy - layout.symbol.size / 2}
            width={layout.symbol.size}
            height={layout.symbol.size}
            listening={false}
            perfectDrawEnabled={false}
          />
        )}
        {marker && (
          <Group x={marker.cx} y={marker.cy} rotation={marker.rotation} listening={false}>
            <Rect
              x={-marker.width / 2}
              y={-marker.height / 2}
              width={marker.width}
              height={marker.height}
              cornerRadius={marker.cornerRadius}
              fill={marker.fill}
              stroke={selectionStroke}
              strokeWidth={2.5 / scale}
              listening={false}
              perfectDrawEnabled={false}
            />
            <CenteredText
              text={marker.text}
              x={0}
              y={0}
              fontSize={marker.fontSize}
              bold
              fill={marker.textColor}
            />
          </Group>
        )}
        {layout.label && layout.text && (
          <CenteredText
            text={layout.label}
            x={layout.text.cx}
            y={layout.text.cy}
            fontSize={layout.fontSize}
            bold={layout.bold}
            fill={layout.textColor}
          />
        )}
      </Group>
    </Group>
  );
});

// ─── Rows ───────────────────────────────────────────────────────────────────

export const RowNode = memo(function RowNode({
  row,
  ends,
  selected,
  dx,
  dy,
  radius,
  scale,
}: {
  row: DocRow;
  /** First / last seat of the row (default label positions). */
  ends: { first: Point; last: Point } | null;
  selected: boolean;
  dx: number;
  dy: number;
  radius: number;
  scale: number;
}) {
  const geometry = dx || dy ? translateRowGeometry(row.geometry, dx, dy) : row.geometry;
  const movedEnds =
    ends && (dx || dy)
      ? {
          first: { x: ends.first.x + dx, y: ends.first.y + dy },
          last: { x: ends.last.x + dx, y: ends.last.y + dy },
        }
      : ends;
  const anchors = rowLabelPoints(geometry, radius, movedEnds);
  const placement = geometry.labelPlacement;
  const fontSize = Math.max(8, radius * 1.3);
  const label = (p: { x: number; y: number }, key: string) => (
    <Text
      key={key}
      text={row.label}
      x={p.x}
      y={p.y}
      width={80}
      offsetX={40}
      offsetY={fontSize / 2}
      align="center"
      fontSize={fontSize}
      fontStyle="bold"
      fill={selected ? COLORS.selection : COLORS.rowLabel}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
  return (
    <Group listening={false}>
      <Line
        points={flat(sampleCurve(geometry.curve))}
        stroke={selected ? COLORS.selection : COLORS.rowGuide}
        strokeWidth={(selected ? 2 : 1) / scale}
        dash={selected ? undefined : [4 / scale, 4 / scale]}
        listening={false}
        perfectDrawEnabled={false}
      />
      {(placement === 'START' || placement === 'BOTH') && label(anchors.start, 's')}
      {(placement === 'END' || placement === 'BOTH') && label(anchors.end, 'e')}
    </Group>
  );
});

// ─── Entrances ──────────────────────────────────────────────────────────────

export const EntranceNode = memo(function EntranceNode({
  entrance,
  selected,
  dx,
  dy,
  radius,
  scale,
}: {
  entrance: DocEntrance;
  selected: boolean;
  dx: number;
  dy: number;
  radius: number;
  scale: number;
}) {
  // Same badge as the public seating chart (see `entranceLayout`).
  const l = entranceLayout({ ...entrance, x: entrance.x + dx, y: entrance.y + dy }, radius);
  return (
    <Group listening={false}>
      <Rect
        x={l.badge.x}
        y={l.badge.y}
        width={l.badge.size}
        height={l.badge.size}
        cornerRadius={l.badge.cornerRadius}
        fill={l.color}
        stroke={selected ? COLORS.selection : '#ffffff'}
        strokeWidth={(selected ? 3 : 1.5) / scale}
        perfectDrawEnabled={false}
        listening={false}
      />
      <CenteredText
        text={entrance.code}
        x={l.code.cx}
        y={l.code.cy}
        fontSize={l.code.fontSize}
        bold
        fill="#ffffff"
      />
      <CenteredText
        text={entrance.name}
        x={l.name.cx}
        y={l.name.cy}
        fontSize={l.name.fontSize}
        bold
        fill={l.color}
      />
    </Group>
  );
});

// ─── Seats (single custom shape) ────────────────────────────────────────────

export interface SeatsShapeProps {
  seats: readonly DocSeat[];
  selected: ReadonlySet<string>;
  highlight: ReadonlySet<string>;
  categoryColors: ReadonlyMap<string, string>;
  radius: number;
  showNumbers: boolean;
  moving: ReadonlySet<string> | null;
  dx: number;
  dy: number;
  /** Seat symbols by id (seat shapes). */
  symbols: ReadonlyMap<string, EditorSymbol>;
  /** Plan-wide default seat shape (null = circle). */
  defaultSymbolId: string | null;
  /** Bumps when a symbol image finished loading → redraw. */
  imagesVersion: number;
  /** Plan labels of wheelchair / companion seats (same rule as the shop). */
  specialLabels: Pick<SeatMapSettings, 'wheelchairLabel' | 'companionLabel'>;
}

/**
 * All seats in one Konva shape: viewport culling, cached symbol images (one per symbol and
 * colour, drawn with drawImage) and no per-seat Konva nodes – stays fluid with 5,000+ seats.
 */
export const SeatsShape = memo(function SeatsShape(props: SeatsShapeProps) {
  const {
    seats,
    selected,
    highlight,
    categoryColors,
    radius,
    showNumbers,
    moving,
    dx,
    dy,
    symbols,
    defaultSymbolId,
    imagesVersion,
    specialLabels,
  } = props;
  void imagesVersion;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(context, shape) => {
        const ctx = context._context;
        const scale = shape.getAbsoluteScale().x || 1;
        const view = visibleWorld(shape);
        const margin = radius * 2;
        const labels = showNumbers && radius * scale >= 7;
        const tiny = radius * scale < 1.5;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `600 ${radius * 0.95}px ui-sans-serif, system-ui, sans-serif`;
        const imageCache = new Map<string, HTMLImageElement | null>();
        const imageFor = (symbolId: string, color: string) => {
          const key = `${symbolId}|${color}`;
          if (!imageCache.has(key)) {
            const symbol = symbols.get(symbolId);
            imageCache.set(key, symbol ? getSymbolImage(symbol, color) : null);
          }
          return imageCache.get(key) ?? null;
        };
        for (const seat of seats) {
          const shift = moving?.has(seat.id) ?? false;
          const x = shift ? seat.x + dx : seat.x;
          const y = shift ? seat.y + dy : seat.y;
          if (
            x < view.minX - margin ||
            x > view.maxX + margin ||
            y < view.minY - margin ||
            y > view.maxY + margin
          ) {
            continue;
          }
          const color =
            (seat.priceCategoryId && categoryColors.get(seat.priceCategoryId)) || COLORS.noCategory;
          const blocked = seat.blockReason !== null;
          const symbolId = seat.symbolId ?? defaultSymbolId;
          const image = !tiny && symbolId ? imageFor(symbolId, color) : null;
          ctx.globalAlpha = blocked ? 0.4 : 1;
          if (image) {
            ctx.save();
            ctx.translate(x, y);
            if (seat.rotation) ctx.rotate((seat.rotation * Math.PI) / 180);
            ctx.drawImage(image, -radius, -radius, radius * 2, radius * 2);
            ctx.restore();
          } else if (tiny) {
            ctx.fillStyle = color;
            ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
          } else {
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          if (blocked) {
            const d = radius * 0.65;
            ctx.beginPath();
            ctx.moveTo(x - d, y - d);
            ctx.lineTo(x + d, y + d);
            ctx.moveTo(x + d, y - d);
            ctx.lineTo(x - d, y + d);
            ctx.lineWidth = Math.max(1 / scale, radius * 0.18);
            ctx.strokeStyle = COLORS.blockedMark;
            ctx.stroke();
          }
          const isSelected = selected.has(seat.id);
          const isHighlighted = highlight.has(seat.id);
          if (isSelected || isHighlighted) {
            ctx.beginPath();
            ctx.arc(x, y, radius + 2 / scale, 0, Math.PI * 2);
            ctx.lineWidth = (isHighlighted ? 3 : 2) / scale;
            ctx.strokeStyle = isHighlighted ? COLORS.highlight : COLORS.selection;
            ctx.stroke();
          }
          const planLabel = blocked ? null : seatPlanLabel(seat, specialLabels);
          // Markers (♿ / + / custom text) show without "seat numbers"; numbers only with it.
          if (planLabel && !tiny && (planLabel.kind === 'MARKER' || labels)) {
            const marker = planLabel.text;
            ctx.fillStyle = image ? '#111827' : contrastText(color);
            if (image) {
              // Readable number on top of an arbitrary symbol.
              ctx.lineWidth = Math.max(1 / scale, radius * 0.2);
              ctx.strokeStyle = '#ffffff';
              ctx.strokeText(marker, x, y + radius * 0.05, radius * 1.8);
            }
            ctx.fillText(marker, x, y + radius * 0.05, radius * 1.8);
          } else if (
            !planLabel &&
            !tiny &&
            !image &&
            (seat.isWheelchairSpace || seat.isCompanionSeat)
          ) {
            ctx.beginPath();
            ctx.arc(x, y, radius * 0.35, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
          }
        }
      }}
    />
  );
});
