'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Options {
  /** Content bounds to fit initially and on reset. */
  bounds: ViewBox;
  /** Maximum magnification relative to the fitted view. */
  maxZoom?: number;
}

const WHEEL_SENSITIVITY = 0.0015;
const BUTTON_FACTOR = 1.35;
const CLICK_TOLERANCE_PX = 6;

function capture(element: EventTarget, pointerId: number): void {
  try {
    (element as Element).setPointerCapture?.(pointerId);
  } catch {
    // pointer already released – nothing to capture
  }
}

/**
 * Smooth pan & zoom for an SVG by manipulating its viewBox:
 *  - mouse wheel / trackpad: continuous zoom anchored at the cursor,
 *  - drag with one pointer: pan,
 *  - two pointers (touch): pinch zoom + pan,
 *  - helpers for buttons (zoom in/out around the centre, reset to fit).
 * `wasDrag()` lets click handlers ignore the click that ends a pan gesture.
 */
export function usePanZoom(
  svgRef: RefObject<SVGSVGElement | null>,
  { bounds, maxZoom = 12 }: Options,
) {
  const [view, setView] = useState<ViewBox>(bounds);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startX: number;
    startY: number;
    moved: boolean;
    pinchDist: number | null;
    /** Element under the pointer when the gesture started (click target). */
    target: Element | null;
  }>({
    startX: 0,
    startY: 0,
    moved: false,
    pinchDist: null,
    target: null,
  });

  // Pixel size of the SVG (for "how big is a seat on screen" decisions).
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const rect = svg.getBoundingClientRect();
      setSize((prev) =>
        prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [svgRef]);

  const minW = bounds.w / maxZoom;
  const maxW = bounds.w * 1.6;

  // Reset when the plan (bounds) changes.
  useEffect(() => setView(bounds), [bounds]);

  /** Client pixel → SVG user coordinates for the current view. */
  const toSvg = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return null;
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const p = point.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    },
    [svgRef],
  );

  /** Units per screen pixel (meet scaling uses the larger ratio). */
  const unitsPerPixel = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return 1;
    const rect = svg.getBoundingClientRect();
    const v = viewRef.current;
    return Math.max(v.w / Math.max(rect.width, 1), v.h / Math.max(rect.height, 1));
  }, [svgRef]);

  const zoomAt = useCallback(
    (factor: number, anchor: { x: number; y: number } | null) => {
      setView((v) => {
        const w = Math.min(maxW, Math.max(minW, v.w / factor));
        const real = v.w / w;
        const h = v.h / real;
        const ax = anchor?.x ?? v.x + v.w / 2;
        const ay = anchor?.y ?? v.y + v.h / 2;
        return { x: ax - (ax - v.x) / real, y: ay - (ay - v.y) / real, w, h };
      });
    },
    [maxW, minW],
  );

  // Native wheel listener: must be non-passive to prevent page scroll while zooming.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(
        Math.exp(-delta * WHEEL_SENSITIVITY * (e.ctrlKey ? 2 : 1)),
        toSvg(e.clientX, e.clientY),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svgRef, toSvg, zoomAt]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      gesture.current = {
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        pinchDist: null,
        target: e.target as Element,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      gesture.current.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.moved = true;
      // Pinch: keep receiving both pointers even when they leave the chart.
      for (const id of pointers.current.keys()) capture(e.currentTarget, id);
    }
    // No pointer capture yet: a plain click must keep its natural target (the seat).
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const next = { x: e.clientX, y: e.clientY };
      pointers.current.set(e.pointerId, next);

      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()] as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const before = gesture.current.pinchDist;
        if (before && dist > 0) zoomAt(dist / before, toSvg((a.x + b.x) / 2, (a.y + b.y) / 2));
        gesture.current.pinchDist = dist;
        return;
      }

      const g = gesture.current;
      if (!g.moved && Math.hypot(next.x - g.startX, next.y - g.startY) > CLICK_TOLERANCE_PX) {
        g.moved = true;
        // Panning: capture so the drag continues outside the chart.
        capture(e.currentTarget, e.pointerId);
      }
      if (!g.moved) return;
      const k = unitsPerPixel();
      const dx = (next.x - prev.x) * k;
      const dy = (next.y - prev.y) * k;
      setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
    },
    [toSvg, unitsPerPixel, zoomAt],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinchDist = null;
  }, []);

  return {
    viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`,
    /** Zoom level relative to the fitted view (1 = fit). */
    zoom: bounds.w / view.w,
    /** Screen pixels per plan unit ("meet" scaling); 0 before the first measurement. */
    pixelsPerUnit: size.w > 0 && size.h > 0 ? Math.min(size.w / view.w, size.h / view.h) : 0,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
    wasDrag: () => gesture.current.moved,
    /** Element that was pressed when the current/last gesture started. */
    pressedTarget: () => gesture.current.target,
    zoomIn: () => zoomAt(BUTTON_FACTOR, null),
    zoomOut: () => zoomAt(1 / BUTTON_FACTOR, null),
    reset: () => setView(bounds),
  };
}
