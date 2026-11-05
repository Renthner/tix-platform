import type {
  ElementGeometry,
  PublicElement,
  PublicEntrance,
  PublicRow,
  PublicSeat,
  PublicSection,
  PublicSymbol,
  SectionGeometry,
} from '@tix/shared';
import {
  ROW_LABEL_OFFSET,
  elementLayout,
  entranceLayout,
  polygonCentroid,
  rowLabelAnchors,
  sectionBounds,
} from '@tix/shared';
import { memo } from 'react';

/** Static SVG layers of the public seating plan (symbols, sections, elements, labels). */

export const symbolRef = (id: string) => `#tix-sym-${id}`;

type ShapeTag = 'polygon' | 'rect' | 'ellipse' | 'path' | 'polyline';

function shapeProps(
  geometry: SectionGeometry | ElementGeometry,
): { tag: ShapeTag; attrs: Record<string, string | number | undefined> } | null {
  switch (geometry.type) {
    case 'polygon':
      return {
        tag: 'polygon',
        attrs: { points: geometry.points.map((p) => `${p.x},${p.y}`).join(' ') },
      };
    case 'rect':
      return {
        tag: 'rect',
        attrs: {
          x: geometry.x,
          y: geometry.y,
          width: geometry.width,
          height: geometry.height,
          rx: 'cornerRadius' in geometry ? geometry.cornerRadius : 0,
          transform: geometry.rotation
            ? `rotate(${geometry.rotation} ${geometry.x} ${geometry.y})`
            : undefined,
        },
      };
    case 'ellipse':
      return {
        tag: 'ellipse',
        attrs: {
          cx: geometry.cx,
          cy: geometry.cy,
          rx: geometry.rx,
          ry: geometry.ry,
          transform: geometry.rotation
            ? `rotate(${geometry.rotation} ${geometry.cx} ${geometry.cy})`
            : undefined,
        },
      };
    case 'path':
      return { tag: 'path', attrs: { d: geometry.d } };
    case 'polyline':
      return {
        tag: 'polyline',
        attrs: { points: geometry.points.map((p) => `${p.x},${p.y}`).join(' ') },
      };
    case 'point':
      return null;
  }
}

export function labelAnchor(geometry: SectionGeometry): { x: number; y: number } | null {
  if (geometry.type === 'polygon') return polygonCentroid(geometry.points);
  const b = sectionBounds(geometry);
  return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null;
}

/** Centre and size of an element (for its symbol / label). */
/** <symbol> definitions for every symbol used by the plan. Markup is sanitised server-side. */
export const SymbolDefs = memo(function SymbolDefs({ symbols }: { symbols: PublicSymbol[] }) {
  return (
    <defs>
      {symbols.map((s) => (
        <symbol
          key={s.id}
          id={`tix-sym-${s.id}`}
          viewBox={s.viewBox}
          fill={s.colorize ? 'currentColor' : undefined}
          dangerouslySetInnerHTML={{ __html: s.markup }}
        />
      ))}
    </defs>
  );
});

export const SectionLayer = memo(function SectionLayer({
  sections,
  categoryColor,
  gaRemaining,
  gaMine,
  remainingLabel,
}: {
  sections: PublicSection[];
  categoryColor: (id: string | null) => string;
  gaRemaining: Record<string, number>;
  gaMine: Record<string, number>;
  remainingLabel: (count: number) => string;
}) {
  return (
    <g>
      {sections.map((section) => {
        const shape = shapeProps(section.geometry);
        if (!shape) return null;
        const standing = section.type === 'STANDING';
        const color = section.color ?? categoryColor(section.priceCategoryId);
        const remaining = gaRemaining[section.id] ?? 0;
        const mine = gaMine[section.id] ?? 0;
        const Tag = shape.tag;
        const anchor = section.label?.position ?? labelAnchor(section.geometry);
        const fontSize = section.label?.fontSize ?? 16;
        const showName = section.showNameOnMap;
        return (
          <g
            key={section.id}
            data-section={standing ? section.id : undefined}
            className={standing && remaining + mine > 0 ? 'cursor-pointer' : undefined}
          >
            <Tag
              {...shape.attrs}
              fill={color}
              fillOpacity={standing ? (remaining > 0 ? 0.35 : 0.12) : 0.06}
              stroke={color}
              strokeOpacity={0.6}
              strokeWidth={mine > 0 ? 4 : 1.5}
            />
            {anchor && (showName || standing) && (
              <text
                x={anchor.x}
                y={anchor.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={fontSize}
                className={`pointer-events-none select-none font-medium ${standing ? 'fill-foreground/70' : 'fill-foreground/45'}`}
              >
                {showName && section.name}
                {standing && (
                  <tspan x={anchor.x} dy={showName ? fontSize * 1.2 : 0} fontSize={fontSize * 0.75}>
                    {remainingLabel(remaining)}
                  </tspan>
                )}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

export const ElementLayer = memo(function ElementLayer({
  elements,
}: {
  elements: PublicElement[];
}) {
  return (
    <g className="pointer-events-none select-none">
      {[...elements]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((element) => {
          const shape = shapeProps(element.geometry);
          const layout = elementLayout(element);
          const Tag = shape?.tag;
          const symbolId = element.style.symbolId;
          return (
            <g key={element.id} opacity={element.style.opacity ?? 1}>
              {Tag && shape && (
                <Tag
                  {...shape.attrs}
                  fill={layout.fill ?? 'none'}
                  stroke={layout.stroke ?? 'none'}
                  strokeWidth={layout.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              <g
                transform={
                  layout.contentRotation && layout.center
                    ? `rotate(${layout.contentRotation} ${layout.center.x} ${layout.center.y})`
                    : undefined
                }
              >
                {layout.symbol && symbolId && (
                  <use
                    href={symbolRef(symbolId)}
                    x={layout.symbol.cx - layout.symbol.size / 2}
                    y={layout.symbol.cy - layout.symbol.size / 2}
                    width={layout.symbol.size}
                    height={layout.symbol.size}
                    color={layout.symbolColor}
                  />
                )}
                {layout.marker && (
                  <g
                    transform={
                      layout.marker.rotation
                        ? `rotate(${layout.marker.rotation} ${layout.marker.cx} ${layout.marker.cy})`
                        : undefined
                    }
                  >
                    <rect
                      x={layout.marker.cx - layout.marker.width / 2}
                      y={layout.marker.cy - layout.marker.height / 2}
                      width={layout.marker.width}
                      height={layout.marker.height}
                      rx={layout.marker.cornerRadius}
                      fill={layout.marker.fill}
                    />
                    <text
                      x={layout.marker.cx}
                      y={layout.marker.cy}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={layout.marker.fontSize}
                      fontWeight="bold"
                      fill={layout.marker.textColor}
                    >
                      {layout.marker.text}
                    </text>
                  </g>
                )}
                {layout.label && layout.text && (
                  <text
                    x={layout.text.cx}
                    y={layout.text.cy}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={layout.fontSize}
                    fontWeight={layout.bold ? 'bold' : 'normal'}
                    fill={layout.textColor}
                  >
                    {layout.label}
                  </text>
                )}
              </g>
            </g>
          );
        })}
    </g>
  );
});

/** Entrances: same badge as in the editor (code in a green rounded square, name below). */
export const EntranceLayer = memo(function EntranceLayer({
  entrances,
  radius,
}: {
  entrances: PublicEntrance[];
  radius: number;
}) {
  return (
    <g className="pointer-events-none select-none">
      {entrances.map((e) => {
        const l = entranceLayout(e, radius);
        return (
          <g key={e.id}>
            <rect
              x={l.badge.x}
              y={l.badge.y}
              width={l.badge.size}
              height={l.badge.size}
              rx={l.badge.cornerRadius}
              fill={l.color}
              stroke="#ffffff"
              strokeWidth={1.5}
            />
            <text
              x={l.code.cx}
              y={l.code.cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={l.code.fontSize}
              fontWeight="bold"
              fill="#ffffff"
            >
              {e.code}
            </text>
            <text
              x={l.name.cx}
              y={l.name.cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={l.name.fontSize}
              fontWeight="600"
              fill={l.color}
            >
              {e.name}
            </text>
          </g>
        );
      })}
    </g>
  );
});

export const RowLabelLayer = memo(function RowLabelLayer({
  rows,
  seatsByRow,
  radius,
}: {
  rows: PublicRow[];
  seatsByRow: Map<string, PublicSeat[]>;
  radius: number;
}) {
  return (
    <g className="pointer-events-none select-none fill-muted-foreground" fontSize={radius * 1.3}>
      {rows.map((row) => {
        const seats = seatsByRow.get(row.id);
        if (!seats || seats.length === 0 || row.geometry.labelPlacement === 'NONE') return null;
        // Same rule as the editor: next to the end seats along the row direction (also for
        // single-seat rows, whose labels sit left and right of the seat).
        const anchors = rowLabelAnchors(row.geometry.curve, radius * ROW_LABEL_OFFSET, {
          first: seats[0]!,
          last: seats[seats.length - 1]!,
        });
        const start = row.geometry.labelStart ?? anchors.start;
        const end = row.geometry.labelEnd ?? anchors.end;
        const placement = row.geometry.labelPlacement;
        return (
          <g key={row.id}>
            {(placement === 'START' || placement === 'BOTH') && (
              <text x={start.x} y={start.y} textAnchor="middle" dominantBaseline="middle">
                {row.label}
              </text>
            )}
            {(placement === 'END' || placement === 'BOTH') && (
              <text x={end.x} y={end.y} textAnchor="middle" dominantBaseline="middle">
                {row.label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

/** Bounding box of everything drawn on the plan (fit-to-content). */
export function contentBounds(
  map: {
    canvasWidth: number;
    canvasHeight: number;
    sections: PublicSection[];
    elements: PublicElement[];
    entrances: PublicEntrance[];
    seats: PublicSeat[];
  },
  padding: number,
): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const s of map.seats) add(s.x, s.y);
  for (const e of map.entrances) add(e.x, e.y);
  for (const section of map.sections) {
    const b = sectionBounds(section.geometry);
    if (b) {
      add(b.minX, b.minY);
      add(b.maxX, b.maxY);
    }
  }
  for (const element of map.elements) {
    const g = element.geometry;
    if (g.type === 'point') add(g.x, g.y);
    else if (g.type === 'polyline') for (const p of g.points) add(p.x, p.y);
    else if (g.type !== 'path') {
      const b = sectionBounds(g as SectionGeometry);
      if (b) {
        add(b.minX, b.minY);
        add(b.maxX, b.maxY);
      }
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: map.canvasWidth, h: map.canvasHeight };
  const w = maxX - minX;
  const h = maxY - minY;
  const pad = Math.max(w, h) * padding + 20;
  return { x: minX - pad, y: minY - pad, w: w + pad * 2, h: h + pad * 2 };
}
