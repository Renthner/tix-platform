'use client';

import type { ElementGeometry, Point, SectionGeometry } from '@tix/shared';
import type Konva from 'konva';
import { Circle } from 'react-konva';
import { moveRowHandle, patchEntity } from './doc-ops';
import { rowLabelPoints, rowSeatEnds, snapPoint } from './geometry';
import { moveRowLabel } from './row-ops';
import { COLORS, soleKind, type Doc, type Selection } from './model';

/**
 * Draggable control points for a single selected row (start / end / arc control), section
 * or element (polygon vertices, rectangle corner, ellipse radius). Each drag is coalesced
 * into one undo step.
 */

export const HANDLE_NAME = 'handle';
const LABEL_HANDLE_COLOR = '#7c3aed';

interface HandlesProps {
  doc: Doc;
  selection: Selection;
  scale: number;
  onApply: (update: (doc: Doc) => Doc, coalesceKey?: string) => void;
}

interface HandleSpec {
  key: string;
  at: Point;
  move: (doc: Doc, p: Point) => Doc;
  color?: string;
}

function shapeHandles(
  geometry: SectionGeometry | ElementGeometry,
  write: (doc: Doc, g: SectionGeometry | ElementGeometry) => Doc,
): HandleSpec[] {
  switch (geometry.type) {
    case 'polygon':
    case 'polyline':
      return geometry.points.map((pt, i) => ({
        key: `v${i}`,
        at: pt,
        move: (doc, p) =>
          write(doc, { ...geometry, points: geometry.points.map((q, j) => (j === i ? p : q)) }),
      }));
    case 'rect':
      return [
        {
          key: 'size',
          at: { x: geometry.x + geometry.width, y: geometry.y + geometry.height },
          move: (doc, p) =>
            write(doc, {
              ...geometry,
              width: Math.max(1, p.x - geometry.x),
              height: Math.max(1, p.y - geometry.y),
            }),
        },
      ];
    case 'ellipse':
      return [
        {
          key: 'radius',
          at: { x: geometry.cx + geometry.rx, y: geometry.cy + geometry.ry },
          move: (doc, p) =>
            write(doc, {
              ...geometry,
              rx: Math.max(1, Math.abs(p.x - geometry.cx)),
              ry: Math.max(1, Math.abs(p.y - geometry.cy)),
            }),
        },
      ];
    default:
      return [];
  }
}

function handlesFor(
  doc: Doc,
  selection: Selection,
): { owner: string; handles: HandleSpec[] } | null {
  const kind = soleKind(selection);
  if (!kind || selection[kind].size !== 1) return null;
  const id = [...selection[kind]][0]!;
  if (kind === 'rows') {
    const row = doc.rows.find((r) => r.id === id);
    if (!row) return null;
    const curve = row.geometry.curve;
    const handles: HandleSpec[] = [
      { key: 'start', at: curve.start, move: (d, p) => moveRowHandle(d, id, 'start', p) },
      { key: 'end', at: curve.end, move: (d, p) => moveRowHandle(d, id, 'end', p) },
    ];
    if (curve.type === 'arc') {
      handles.push({
        key: 'control',
        at: curve.control,
        move: (d, p) => moveRowHandle(d, id, 'control', p),
        color: '#f59e0b',
      });
    }
    // Row labels: dragging writes explicit positions (labelStart / labelEnd).
    const labels = rowLabelPoints(row.geometry, doc.settings.seatRadius, rowSeatEnds(doc, row.id));
    const placement = row.geometry.labelPlacement;
    if (placement === 'START' || placement === 'BOTH') {
      handles.push({
        key: 'label-start',
        at: labels.start,
        move: (d, p) => moveRowLabel(d, id, 'start', p),
        color: LABEL_HANDLE_COLOR,
      });
    }
    if (placement === 'END' || placement === 'BOTH') {
      handles.push({
        key: 'label-end',
        at: labels.end,
        move: (d, p) => moveRowLabel(d, id, 'end', p),
        color: LABEL_HANDLE_COLOR,
      });
    }
    return { owner: `row:${id}`, handles };
  }
  if (kind === 'sections') {
    const section = doc.sections.find((s) => s.id === id);
    if (!section) return null;
    return {
      owner: `section:${id}`,
      handles: shapeHandles(section.geometry, (d, g) =>
        patchEntity(d, 'sections', id, { geometry: g as SectionGeometry }),
      ),
    };
  }
  if (kind === 'elements') {
    const element = doc.elements.find((e) => e.id === id);
    if (!element) return null;
    return {
      owner: `element:${id}`,
      handles: shapeHandles(element.geometry, (d, g) =>
        patchEntity(d, 'elements', id, { geometry: g as ElementGeometry }),
      ),
    };
  }
  return null;
}

export function Handles({ doc, selection, scale, onApply }: HandlesProps) {
  const spec = handlesFor(doc, selection);
  if (!spec) return null;
  return (
    <>
      {spec.handles.map((h) => (
        <Circle
          key={`${spec.owner}:${h.key}`}
          name={HANDLE_NAME}
          x={h.at.x}
          y={h.at.y}
          radius={6 / scale}
          fill="#ffffff"
          stroke={h.color ?? COLORS.selection}
          strokeWidth={2 / scale}
          draggable
          perfectDrawEnabled={false}
          onMouseEnter={(e: Konva.KonvaEventObject<MouseEvent>) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'move';
          }}
          onMouseLeave={(e: Konva.KonvaEventObject<MouseEvent>) => {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = '';
          }}
          onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => {
            const p = snapPoint(e.target.position(), doc.settings);
            e.target.position(p);
            onApply((d) => h.move(d, p), `handle:${spec.owner}:${h.key}`);
          }}
        />
      ))}
    </>
  );
}
