'use client';

import {
  layoutRowSeats,
  seatCountForSpacing,
  type DocSeat,
  type ElementGeometry,
  type Point,
  type RowGeometry,
  type SeatMapElementType,
  type SectionGeometry,
} from '@tix/shared';
import type Konva from 'konva';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Circle, Layer, Line, Rect, Stage } from 'react-konva';
import {
  CanvasBackground,
  ElementNode,
  EntranceNode,
  RowNode,
  SeatsShape,
  SectionNode,
} from './canvas-layers';
import { collectMoveSet, translateEntities, type EntitySets } from './doc-ops';
import {
  distance,
  distanceToPolyline,
  docContentBounds,
  elementBounds,
  elementContains,
  pointInBounds,
  rectFromPoints,
  rowLabelPoints,
  sampleCurve,
  sectionContains,
  snapPoint,
  snapValue,
} from './geometry';
import { HANDLE_NAME, Handles } from './handles';
import {
  COLORS,
  EMPTY_SELECTION,
  MAX_SCALE,
  MIN_SCALE,
  mergeSelection,
  selectOnly,
  toggleInSelection,
  type Doc,
  type EntityKind,
  type Selection,
  type Tool,
  type View,
} from './model';
import { SeatIndex } from './seat-index';
import type { EditorSymbol } from './types';

/** What the canvas asks the editor to create once the user finished drawing. */
export type CreateRequest =
  | { kind: 'section'; geometry: SectionGeometry }
  | { kind: 'row'; curve: RowGeometry['curve'] }
  | { kind: 'table'; point: Point }
  | { kind: 'element'; elementType: SeatMapElementType; geometry: ElementGeometry }
  | { kind: 'entrance'; point: Point };

export interface CanvasHandle {
  fit(): void;
  zoomBy(factor: number): void;
  /** Cancels an in-progress drawing / drag. Returns true when something was cancelled. */
  cancel(): boolean;
  /** Finishes a polygon / polyline being drawn (Enter). */
  finish(): void;
}

interface CanvasProps {
  doc: Doc;
  selection: Selection;
  highlight: ReadonlySet<string>;
  categoryColors: ReadonlyMap<string, string>;
  tool: Tool;
  view: View;
  onViewChange: (view: View) => void;
  onSelect: (selection: Selection) => void;
  onApply: (update: (doc: Doc) => Doc, coalesceKey?: string) => void;
  onCreate: (request: CreateRequest) => void;
  onPointerWorld?: (p: Point | null) => void;
  /** Symbol library by id (seat shapes and element symbols). */
  symbols: ReadonlyMap<string, EditorSymbol>;
  /** Bumps when a symbol image finished loading. */
  imagesVersion: number;
  /** Suffix shown after block names that are hidden on the public seating chart. */
  hiddenNameSuffix: string;
}

type Interaction =
  | { type: 'idle' }
  | { type: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { type: 'marquee'; start: Point; additive: boolean }
  | {
      type: 'drag';
      start: Point;
      set: EntitySets;
      moved: boolean;
      hit: { kind: EntityKind; id: string } | null;
      collapseOnClick: boolean;
    }
  | { type: 'rect'; start: Point };

const RECT_TOOLS: ReadonlySet<Tool> = new Set([
  'section-rect',
  'stage',
  'shape-rect',
  'shape-ellipse',
]);
const PATH_TOOLS: ReadonlySet<Tool> = new Set(['section-polygon', 'shape-polygon', 'line']);
const POINT_TOOLS: ReadonlySet<Tool> = new Set(['table', 'text', 'exit', 'facility', 'entrance']);
const DRAG_THRESHOLD_PX = 3;
const CLOSE_PATH_PX = 10;

export const EditorCanvas = forwardRef<CanvasHandle, CanvasProps>(
  function EditorCanvas(props, ref) {
    const {
      doc,
      selection,
      highlight,
      categoryColors,
      tool,
      view,
      onViewChange,
      onSelect,
      onApply,
      onCreate,
      symbols,
      imagesVersion,
      hiddenNameSuffix,
    } = props;
    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<Konva.Stage>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const interaction = useRef<Interaction>({ type: 'idle' });
    const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null);
    const [rectDraft, setRectDraft] = useState<{ a: Point; b: Point } | null>(null);
    const [points, setPoints] = useState<Point[]>([]);
    const [cursor, setCursor] = useState<Point | null>(null);
    const [drag, setDrag] = useState<{ set: EntitySets; dx: number; dy: number } | null>(null);
    const [spaceDown, setSpaceDown] = useState(false);
    const [panning, setPanning] = useState(false);
    const fitted = useRef(false);

    const settings = doc.settings;
    const radius = settings.seatRadius;
    const index = useMemo(
      () => new SeatIndex(doc.seats, Math.max(4, radius * 4)),
      [doc.seats, radius],
    );
    const specialLabels = useMemo(
      () => ({
        wheelchairLabel: settings.wheelchairLabel,
        companionLabel: settings.companionLabel,
      }),
      [settings.wheelchairLabel, settings.companionLabel],
    );
    /** First / last seat per row – default row label positions (same rule as the shop). */
    const rowEnds = useMemo(() => {
      const ends = new Map<string, { first: DocSeat; last: DocSeat }>();
      for (const seat of doc.seats) {
        if (!seat.rowId) continue;
        const e = ends.get(seat.rowId);
        const p = seat.position ?? 0;
        if (!e) ends.set(seat.rowId, { first: seat, last: seat });
        else {
          if (p < (e.first.position ?? 0)) e.first = seat;
          if (p > (e.last.position ?? 0)) e.last = seat;
        }
      }
      return ends;
    }, [doc.seats]);

    // ── Size & keyboard state ─────────────────────────────────────────────────
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry)
          setSize({
            width: Math.floor(entry.contentRect.width),
            height: Math.floor(entry.contentRect.height),
          });
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const isTyping = (t: EventTarget | null) =>
        t instanceof HTMLElement &&
        (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      const down = (e: KeyboardEvent) => {
        if (e.code === 'Space' && !isTyping(e.target)) {
          setSpaceDown(true);
          e.preventDefault();
        }
      };
      const up = (e: KeyboardEvent) => {
        if (e.code === 'Space') setSpaceDown(false);
      };
      window.addEventListener('keydown', down);
      window.addEventListener('keyup', up);
      return () => {
        window.removeEventListener('keydown', down);
        window.removeEventListener('keyup', up);
      };
    }, []);

    // Drawing state is tied to the active tool.
    useEffect(() => {
      setPoints([]);
      setRectDraft(null);
      interaction.current = { type: 'idle' };
    }, [tool]);

    // ── View helpers ──────────────────────────────────────────────────────────
    const fit = useCallback(() => {
      if (size.width === 0 || size.height === 0) return;
      const bounds = docContentBounds(doc) ?? {
        minX: 0,
        minY: 0,
        maxX: doc.canvasWidth,
        maxY: doc.canvasHeight,
      };
      const pad = 40;
      const w = Math.max(1, bounds.maxX - bounds.minX);
      const h = Math.max(1, bounds.maxY - bounds.minY);
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Math.min((size.width - pad * 2) / w, (size.height - pad * 2) / h)),
      );
      onViewChange({
        scale,
        x: (size.width - w * scale) / 2 - bounds.minX * scale,
        y: (size.height - h * scale) / 2 - bounds.minY * scale,
      });
    }, [doc, size, onViewChange]);

    useEffect(() => {
      if (!fitted.current && size.width > 0) {
        fitted.current = true;
        fit();
      }
    }, [size, fit]);

    const zoomAt = useCallback(
      (factor: number, anchor: { x: number; y: number }) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
        const world = { x: (anchor.x - view.x) / view.scale, y: (anchor.y - view.y) / view.scale };
        onViewChange({ scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale });
      },
      [view, onViewChange],
    );

    const finishPath = useCallback(() => {
      if (!PATH_TOOLS.has(tool)) return;
      const pts = dedupe(points);
      if (tool === 'line' ? pts.length >= 2 : pts.length >= 3) {
        if (tool === 'section-polygon')
          onCreate({ kind: 'section', geometry: { type: 'polygon', points: pts } });
        else if (tool === 'shape-polygon') {
          onCreate({
            kind: 'element',
            elementType: 'SHAPE',
            geometry: { type: 'polygon', points: pts },
          });
        } else
          onCreate({
            kind: 'element',
            elementType: 'LINE',
            geometry: { type: 'polyline', points: pts },
          });
      }
      setPoints([]);
    }, [tool, points, onCreate]);

    useImperativeHandle(
      ref,
      () => ({
        fit,
        zoomBy: (factor) => zoomAt(factor, { x: size.width / 2, y: size.height / 2 }),
        cancel: () => {
          const busy =
            points.length > 0 || rectDraft !== null || interaction.current.type !== 'idle';
          setPoints([]);
          setRectDraft(null);
          setMarquee(null);
          setDrag(null);
          interaction.current = { type: 'idle' };
          return busy;
        },
        finish: finishPath,
      }),
      [fit, zoomAt, size, points, rectDraft, finishPath],
    );

    // ── Hit testing ───────────────────────────────────────────────────────────
    const hitTest = useCallback(
      (p: Point): { kind: EntityKind; id: string } | null => {
        const tolerance = 4 / view.scale;
        const seat = index.nearest(p, radius + tolerance);
        if (seat) return { kind: 'seats', id: seat };
        for (let i = doc.entrances.length - 1; i >= 0; i -= 1) {
          const e = doc.entrances[i]!;
          if (distance(p, e) <= Math.max(10, radius * 1.8) + tolerance)
            return { kind: 'entrances', id: e.id };
        }
        const elements = [...doc.elements].sort((a, b) => b.zIndex - a.zIndex);
        for (const e of elements) {
          if (elementContains(e.geometry, p, tolerance * 2)) return { kind: 'elements', id: e.id };
        }
        for (const r of doc.rows) {
          const curve = r.geometry.curve;
          const anchors = rowLabelPoints(r.geometry, radius, rowEnds.get(r.id));
          if (
            distance(p, anchors.start) <= radius * 1.4 ||
            distance(p, anchors.end) <= radius * 1.4 ||
            distanceToPolyline(p, sampleCurve(curve)) <= Math.max(radius * 0.5, tolerance)
          ) {
            return { kind: 'rows', id: r.id };
          }
        }
        for (let i = doc.sections.length - 1; i >= 0; i -= 1) {
          const s = doc.sections[i]!;
          if (sectionContains(s.geometry, p)) return { kind: 'sections', id: s.id };
        }
        return null;
      },
      [doc, index, radius, rowEnds, view.scale],
    );

    // ── Pointer handling ──────────────────────────────────────────────────────
    const pointer = (): { screen: { x: number; y: number }; world: Point } | null => {
      const p = stageRef.current?.getPointerPosition();
      if (!p) return null;
      return {
        screen: p,
        world: { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale },
      };
    };

    const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (e.target.name() === HANDLE_NAME) return;
      const p = pointer();
      if (!p) return;
      const button = e.evt.button;
      if (button === 2) return;
      if (button === 1 || spaceDown || tool === 'hand') {
        e.evt.preventDefault();
        interaction.current = {
          type: 'pan',
          sx: p.screen.x,
          sy: p.screen.y,
          ox: view.x,
          oy: view.y,
        };
        setPanning(true);
        return;
      }
      const snapped = snapPoint(p.world, settings);

      if (tool === 'select') {
        const hit = hitTest(p.world);
        const shift = e.evt.shiftKey;
        if (!hit) {
          if (!shift) onSelect(EMPTY_SELECTION);
          interaction.current = { type: 'marquee', start: p.world, additive: shift };
          setMarquee({ a: p.world, b: p.world });
          return;
        }
        const alreadySelected = selection[hit.kind].has(hit.id);
        if (shift) {
          const next = toggleInSelection(selection, hit.kind, hit.id);
          onSelect(next);
          if (!alreadySelected) {
            interaction.current = {
              type: 'drag',
              start: snapped,
              set: collectMoveSet(doc, next),
              moved: false,
              hit,
              collapseOnClick: false,
            };
          }
          return;
        }
        const next = alreadySelected ? selection : selectOnly(hit.kind, [hit.id]);
        if (!alreadySelected) onSelect(next);
        interaction.current = {
          type: 'drag',
          start: snapped,
          set: collectMoveSet(doc, next),
          moved: false,
          hit,
          collapseOnClick: alreadySelected,
        };
        return;
      }

      if (RECT_TOOLS.has(tool)) {
        interaction.current = { type: 'rect', start: snapped };
        setRectDraft({ a: snapped, b: snapped });
        return;
      }

      if (PATH_TOOLS.has(tool)) {
        const first = points[0];
        if (
          first &&
          points.length >= 3 &&
          distance(first, snapped) * view.scale <= CLOSE_PATH_PX &&
          tool !== 'line'
        ) {
          finishPath();
          return;
        }
        setPoints((prev) => [...prev, snapped]);
        return;
      }

      if (tool === 'row-straight' || tool === 'row-arc') {
        const next = [...points, snapped];
        if (tool === 'row-straight' && next.length === 2) {
          if (distance(next[0]!, next[1]!) > 1)
            onCreate({ kind: 'row', curve: { type: 'straight', start: next[0]!, end: next[1]! } });
          setPoints([]);
        } else if (tool === 'row-arc' && next.length === 3) {
          if (distance(next[0]!, next[1]!) > 1) {
            onCreate({
              kind: 'row',
              curve: { type: 'arc', start: next[0]!, end: next[1]!, control: next[2]! },
            });
          }
          setPoints([]);
        } else {
          setPoints(next);
        }
        return;
      }

      if (POINT_TOOLS.has(tool)) {
        if (tool === 'table') onCreate({ kind: 'table', point: snapped });
        else if (tool === 'entrance') onCreate({ kind: 'entrance', point: snapped });
        else {
          const elementType: SeatMapElementType =
            tool === 'text' ? 'TEXT' : tool === 'exit' ? 'EXIT' : 'FACILITY';
          onCreate({
            kind: 'element',
            elementType,
            geometry: { type: 'point', x: snapped.x, y: snapped.y, rotation: 0 },
          });
        }
      }
    };

    const onMouseMove = () => {
      const p = pointer();
      if (!p) return;
      props.onPointerWorld?.(p.world);
      const current = interaction.current;
      switch (current.type) {
        case 'pan':
          onViewChange({
            scale: view.scale,
            x: current.ox + (p.screen.x - current.sx),
            y: current.oy + (p.screen.y - current.sy),
          });
          return;
        case 'marquee':
          setMarquee({ a: current.start, b: p.world });
          return;
        case 'drag': {
          const snapped = snapPoint(p.world, settings);
          const dx = snapValue(snapped.x - current.start.x, settings);
          const dy = snapValue(snapped.y - current.start.y, settings);
          if (!current.moved && Math.hypot(dx, dy) * view.scale < DRAG_THRESHOLD_PX) return;
          current.moved = true;
          setDrag({ set: current.set, dx, dy });
          return;
        }
        case 'rect':
          setRectDraft({ a: current.start, b: snapPoint(p.world, settings) });
          return;
        default:
          if (PATH_TOOLS.has(tool) || tool === 'row-straight' || tool === 'row-arc')
            setCursor(snapPoint(p.world, settings));
      }
    };

    const finishInteraction = (shiftKey: boolean) => {
      const current = interaction.current;
      if (current.type === 'idle') return;
      interaction.current = { type: 'idle' };
      switch (current.type) {
        case 'pan':
          setPanning(false);
          return;
        case 'marquee': {
          setMarquee(null);
          const p = pointer();
          if (!p) return;
          const r = rectFromPoints(current.start, p.world);
          if (r.width * view.scale < 3 && r.height * view.scale < 3) return;
          const bounds = { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height };
          const picked: Selection = {
            ...EMPTY_SELECTION,
            seats: new Set(index.inRect(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY)),
            elements: new Set(
              doc.elements
                .filter((el) => {
                  const b = elementBounds(el.geometry);
                  return (
                    b &&
                    pointInBounds({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, bounds)
                  );
                })
                .map((el) => el.id),
            ),
            entrances: new Set(
              doc.entrances.filter((en) => pointInBounds(en, bounds)).map((en) => en.id),
            ),
          };
          onSelect(current.additive ? mergeSelection(selection, picked) : picked);
          return;
        }
        case 'drag': {
          const moved = drag;
          setDrag(null);
          if (current.moved && moved && (moved.dx !== 0 || moved.dy !== 0)) {
            onApply((d) => translateEntities(d, current.set, moved.dx, moved.dy));
          } else if (!current.moved && current.collapseOnClick && current.hit && !shiftKey) {
            onSelect(selectOnly(current.hit.kind, [current.hit.id]));
          }
          return;
        }
        case 'rect': {
          setRectDraft(null);
          const p = pointer();
          if (!p) return;
          const r = rectFromPoints(current.start, snapPoint(p.world, settings));
          if (r.width * view.scale < 6 || r.height * view.scale < 6) return;
          if (tool === 'section-rect') {
            onCreate({ kind: 'section', geometry: { type: 'rect', ...r, rotation: 0 } });
          } else if (tool === 'shape-ellipse') {
            onCreate({
              kind: 'element',
              elementType: 'SHAPE',
              geometry: {
                type: 'ellipse',
                cx: r.x + r.width / 2,
                cy: r.y + r.height / 2,
                rx: r.width / 2,
                ry: r.height / 2,
                rotation: 0,
              },
            });
          } else {
            onCreate({
              kind: 'element',
              elementType: tool === 'stage' ? 'STAGE' : 'SHAPE',
              geometry: { type: 'rect', ...r, rotation: 0, cornerRadius: 0 },
            });
          }
          return;
        }
        default:
      }
    };

    // Releasing the mouse outside the canvas must still end drags / marquees.
    const finishRef = useRef(finishInteraction);
    finishRef.current = finishInteraction;
    useEffect(() => {
      const up = (e: MouseEvent) => finishRef.current(e.shiftKey);
      window.addEventListener('mouseup', up);
      return () => window.removeEventListener('mouseup', up);
    }, []);

    const onDblClick = () => {
      if (PATH_TOOLS.has(tool)) {
        finishPath();
        return;
      }
      if (tool !== 'select') return;
      const p = pointer();
      if (!p) return;
      const hit = hitTest(p.world);
      if (hit?.kind === 'seats') {
        const seat = doc.seats.find((s) => s.id === hit.id);
        if (seat?.rowId) onSelect(selectOnly('rows', [seat.rowId]));
        else if (seat?.tableElementId) onSelect(selectOnly('elements', [seat.tableElementId]));
      } else if (hit?.kind === 'sections') {
        onSelect(
          selectOnly(
            'seats',
            doc.seats.filter((s) => s.sectionId === hit.id).map((s) => s.id),
          ),
        );
      } else if (hit?.kind === 'rows') {
        onSelect(
          selectOnly(
            'seats',
            doc.seats.filter((s) => s.rowId === hit.id).map((s) => s.id),
          ),
        );
      }
    };

    const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const anchor = stageRef.current?.getPointerPosition();
      if (!anchor) return;
      const factor = Math.pow(1.0015, -Math.max(-300, Math.min(300, e.evt.deltaY)));
      zoomAt(factor, anchor);
    };

    // ── Rendering ─────────────────────────────────────────────────────────────
    const offset = (kind: EntityKind, id: string) =>
      drag && drag.set[kind].has(id) ? { dx: drag.dx, dy: drag.dy } : { dx: 0, dy: 0 };

    const preview = useMemo(() => {
      if (tool !== 'row-straight' && tool !== 'row-arc') return null;
      if (points.length === 0 || !cursor) return null;
      const curve: RowGeometry['curve'] =
        points.length === 1
          ? { type: 'straight', start: points[0]!, end: cursor }
          : { type: 'arc', start: points[0]!, end: points[1]!, control: cursor };
      const count = Math.min(500, seatCountForSpacing(curve, radius * 2.6));
      return { curve, seats: count > 0 ? layoutRowSeats(curve, count) : [] };
    }, [tool, points, cursor, radius]);

    const cursorStyle = panning
      ? 'grabbing'
      : spaceDown || tool === 'hand'
        ? 'grab'
        : tool === 'select'
          ? 'default'
          : 'crosshair';

    const sortedElements = useMemo(
      () => [...doc.elements].sort((a, b) => a.zIndex - b.zIndex),
      [doc.elements],
    );

    return (
      <div
        ref={containerRef}
        className="relative h-full w-full overflow-hidden"
        style={{ background: COLORS.outside, cursor: cursorStyle }}
        onContextMenu={(e) => e.preventDefault()}
        onMouseLeave={() => props.onPointerWorld?.(null)}
      >
        {size.width > 0 && (
          <Stage
            ref={stageRef}
            width={size.width}
            height={size.height}
            scaleX={view.scale}
            scaleY={view.scale}
            x={view.x}
            y={view.y}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={(e) => finishInteraction(e.evt.shiftKey)}
            onDblClick={onDblClick}
            onWheel={onWheel}
          >
            <Layer listening={false}>
              <CanvasBackground
                width={doc.canvasWidth}
                height={doc.canvasHeight}
                settings={settings}
              />
            </Layer>
            <Layer listening={false}>
              {doc.sections.map((s) => {
                const o = offset('sections', s.id);
                return (
                  <SectionNode
                    key={s.id}
                    section={s}
                    selected={selection.sections.has(s.id)}
                    dx={o.dx}
                    dy={o.dy}
                    scale={view.scale}
                    hiddenNameSuffix={hiddenNameSuffix}
                  />
                );
              })}
              {sortedElements.map((el) => {
                const o = offset('elements', el.id);
                return (
                  <ElementNode
                    key={el.id}
                    element={el}
                    selected={selection.elements.has(el.id)}
                    dx={o.dx}
                    dy={o.dy}
                    scale={view.scale}
                    symbol={(el.style.symbolId && symbols.get(el.style.symbolId)) || null}
                    imagesVersion={imagesVersion}
                  />
                );
              })}
              {doc.rows.map((r) => {
                const o = offset('rows', r.id);
                return (
                  <RowNode
                    key={r.id}
                    row={r}
                    ends={rowEnds.get(r.id) ?? null}
                    selected={selection.rows.has(r.id)}
                    dx={o.dx}
                    dy={o.dy}
                    radius={radius}
                    scale={view.scale}
                  />
                );
              })}
              {doc.entrances.map((en) => {
                const o = offset('entrances', en.id);
                return (
                  <EntranceNode
                    key={en.id}
                    entrance={en}
                    selected={selection.entrances.has(en.id)}
                    dx={o.dx}
                    dy={o.dy}
                    radius={radius}
                    scale={view.scale}
                  />
                );
              })}
            </Layer>
            <Layer listening={false}>
              <SeatsShape
                seats={doc.seats}
                selected={selection.seats}
                highlight={highlight}
                categoryColors={categoryColors}
                radius={radius}
                showNumbers={settings.showSeatNumbers}
                moving={drag ? drag.set.seats : null}
                dx={drag?.dx ?? 0}
                dy={drag?.dy ?? 0}
                symbols={symbols}
                defaultSymbolId={settings.defaultSeatSymbolId ?? null}
                imagesVersion={imagesVersion}
                specialLabels={specialLabels}
              />
            </Layer>
            <Layer>
              {marquee && (
                <Rect
                  {...rectFromPoints(marquee.a, marquee.b)}
                  fill="rgba(37,99,235,0.08)"
                  stroke={COLORS.selection}
                  strokeWidth={1 / view.scale}
                  dash={[4 / view.scale, 3 / view.scale]}
                  listening={false}
                />
              )}
              {rectDraft && (
                <Rect
                  {...rectFromPoints(rectDraft.a, rectDraft.b)}
                  fill="rgba(37,99,235,0.1)"
                  stroke={COLORS.preview}
                  strokeWidth={1.5 / view.scale}
                  listening={false}
                />
              )}
              {points.length > 0 && PATH_TOOLS.has(tool) && (
                <Line
                  points={[...points, ...(cursor ? [cursor] : [])].flatMap((p) => [p.x, p.y])}
                  stroke={COLORS.preview}
                  strokeWidth={1.5 / view.scale}
                  dash={[6 / view.scale, 4 / view.scale]}
                  closed={tool !== 'line' && points.length >= 2}
                  fill={tool !== 'line' ? 'rgba(37,99,235,0.08)' : undefined}
                  listening={false}
                />
              )}
              {(PATH_TOOLS.has(tool) || tool === 'row-straight' || tool === 'row-arc') &&
                points.map((p, i) => (
                  <Circle
                    key={i}
                    x={p.x}
                    y={p.y}
                    radius={4 / view.scale}
                    fill={COLORS.preview}
                    listening={false}
                  />
                ))}
              {preview && (
                <>
                  <Line
                    points={sampleCurve(preview.curve).flatMap((p) => [p.x, p.y])}
                    stroke={COLORS.preview}
                    strokeWidth={1.5 / view.scale}
                    dash={[6 / view.scale, 4 / view.scale]}
                    listening={false}
                  />
                  {preview.seats.map((s, i) => (
                    <Circle
                      key={i}
                      x={s.x}
                      y={s.y}
                      radius={radius}
                      stroke={COLORS.preview}
                      strokeWidth={1 / view.scale}
                      listening={false}
                      perfectDrawEnabled={false}
                    />
                  ))}
                </>
              )}
              {tool === 'select' && !drag && (
                <Handles doc={doc} selection={selection} scale={view.scale} onApply={onApply} />
              )}
            </Layer>
          </Stage>
        )}
      </div>
    );
  },
);

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || distance(p, points[i - 1]!) > 0.01);
}

/** Exported for the editor (e.g. nudge with arrow keys). */
export function nudge(doc: Doc, selection: Selection, dx: number, dy: number): Doc {
  return translateEntities(doc, collectMoveSet(doc, selection), dx, dy);
}
