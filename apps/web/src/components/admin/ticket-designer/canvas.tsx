'use client';

import type { TicketLayout, TicketLayoutElement, TicketTextElement } from '@tix/shared';
import type Konva from 'konva';
import { useEffect, useRef, useState } from 'react';
import {
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva';
import { usePreviewFontFamily } from './preview-font';

/** Konva stage of the ticket designer. All coordinates are millimetres (stage scale = px/mm). */

export const QR_ID = 'qr';
const PT_TO_MM = 25.4 / 72;

export type ElementPatch = Record<string, unknown>;

function useImage(url: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!url) {
      setImage(null);
      return;
    }
    let cancelled = false;
    const img = new window.Image();
    img.onload = () => {
      if (!cancelled) setImage(img);
    };
    img.onerror = () => {
      if (!cancelled) setImage(null);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return image;
}

/** Crop rectangle (image pixels) that makes `image` fill a box of the given aspect ratio. */
function coverCrop(image: HTMLImageElement, boxWidth: number, boxHeight: number) {
  const scale = Math.max(boxWidth / image.width, boxHeight / image.height);
  const width = boxWidth / scale;
  const height = boxHeight / scale;
  return { x: (image.width - width) / 2, y: (image.height - height) / 2, width, height };
}

function FitImage({
  image,
  width,
  height,
  fit,
  opacity = 1,
}: {
  image: HTMLImageElement;
  width: number;
  height: number;
  fit: 'cover' | 'contain';
  opacity?: number;
}) {
  if (fit === 'cover') {
    return (
      <KonvaImage
        image={image}
        width={width}
        height={height}
        crop={coverCrop(image, width, height)}
        opacity={opacity}
        listening={false}
      />
    );
  }
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  return (
    <KonvaImage
      image={image}
      x={(width - w) / 2}
      y={(height - h) / 2}
      width={w}
      height={h}
      opacity={opacity}
      listening={false}
    />
  );
}

export interface DesignerCanvasProps {
  pageWidthMm: number;
  pageHeightMm: number;
  layout: TicketLayout;
  backgroundUrl: string | null;
  coverUrl: string | null;
  /** Text printed for an element in the canvas (sample data). */
  textFor: (element: TicketTextElement) => string;
  selectedId: string | null;
  /** Pixels per millimetre. */
  scale: number;
  coverLabel: string;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: ElementPatch) => void;
}

const snap = (v: number) => Math.round(v * 2) / 2;

function AssetImage({
  element,
  onSelectEl,
  commonProps,
}: {
  element: Extract<TicketLayoutElement, { kind: 'image' }>;
  onSelectEl: () => void;
  commonProps: Record<string, unknown>;
}) {
  const image = useImage(`/api/media/${element.assetId}`);
  return (
    <Group {...commonProps} onMouseDown={onSelectEl} onTap={onSelectEl}>
      <Rect width={element.width} height={element.height} fill="rgba(0,0,0,0.02)" />
      {image && (
        <FitImage
          image={image}
          width={element.width}
          height={element.height}
          fit="contain"
          opacity={element.opacity}
        />
      )}
    </Group>
  );
}

export function DesignerCanvas(props: DesignerCanvasProps) {
  // Every family prints in the bundled Noto Sans; the preview loads the same font files.
  const previewFont = usePreviewFontFamily();
  const { pageWidthMm, pageHeightMm, layout, scale, selectedId, onSelect, onChange } = props;
  const background = useImage(props.backgroundUrl);
  const cover = useImage(props.coverUrl);
  const trRef = useRef<Konva.Transformer>(null);
  const layerRef = useRef<Konva.Layer>(null);
  /** Size while a transform is in progress (mm). Resizing changes the box, never scales content. */
  const [live, setLive] = useState<{ id: string; width: number; height: number } | null>(null);
  const selected =
    selectedId === QR_ID ? 'qr' : layout.elements.find((e) => e.id === selectedId)?.kind;

  useEffect(() => {
    const tr = trRef.current;
    const layer = layerRef.current;
    if (!tr || !layer) return;
    const node = selectedId ? layer.findOne(`.el-${selectedId}`) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, layout, scale]);

  const qrSize = live?.id === QR_ID ? live.width : layout.qr.size;
  const selectedLine = (() => {
    const el = layout.elements.find((e) => e.id === selectedId);
    return el?.kind === 'shape' && el.shape === 'line' ? el : null;
  })();

  const common = (
    id: string,
    x: number,
    y: number,
    rotation = 0,
    baseWidth = 0,
    baseHeight = 0,
    isLine = false,
  ) => {
    const width = live?.id === id ? live.width : baseWidth;
    const height = live?.id === id ? live.height : baseHeight;
    return {
      name: `el-${id}`,
      x,
      y,
      rotation,
      width,
      height,
      draggable: true,
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) =>
        onChange(id, { x: Math.max(0, snap(e.target.x())), y: Math.max(0, snap(e.target.y())) }),
      onTransform: (e: Konva.KonvaEventObject<Event>) => {
        // Real text-box behaviour: fold the scale into the size right away.
        const node = e.target;
        const sx = node.scaleX();
        const sy = node.scaleY();
        if (sx === 1 && sy === 1) return;
        const minH = isLine ? 0 : 1;
        let w = Math.max(isLine && node.width() === 0 ? 0 : 1, node.width() * sx);
        let h = Math.max(minH, node.height() * sy);
        if (id === QR_ID) {
          w = Math.max(10, Math.max(w, h));
          h = w;
        }
        node.setAttrs({ width: w, height: h, scaleX: 1, scaleY: 1 });
        setLive({ id, width: w, height: h });
      },
      onTransformEnd: (e: Konva.KonvaEventObject<Event>) => {
        const node = e.target;
        node.scaleX(1);
        node.scaleY(1);
        const patch: ElementPatch = {
          x: Math.max(0, snap(node.x())),
          y: Math.max(0, snap(node.y())),
          width: isLine && node.width() === 0 ? 0 : Math.max(1, snap(node.width())),
          height: isLine && node.height() === 0 ? 0 : Math.max(isLine ? 0 : 1, snap(node.height())),
        };
        if (id !== QR_ID) patch.rotation = Math.round(node.rotation());
        if (id === QR_ID) {
          patch.size = Math.max(10, snap(Math.max(node.width(), node.height())));
          delete patch.width;
          delete patch.height;
        }
        setLive(null);
        onChange(id, patch);
      },
    };
  };

  return (
    <Stage
      width={pageWidthMm * scale}
      height={pageHeightMm * scale}
      scaleX={scale}
      scaleY={scale}
      onMouseDown={(e) => {
        if (e.target === e.target.getStage() || e.target.name() === 'page') onSelect(null);
      }}
    >
      <Layer ref={layerRef}>
        <Rect name="page" width={pageWidthMm} height={pageHeightMm} fill="#ffffff" />
        {background && (
          <FitImage image={background} width={pageWidthMm} height={pageHeightMm} fit="cover" />
        )}
        {layout.elements.map((source) => {
          const element =
            live?.id === source.id ? { ...source, width: live.width, height: live.height } : source;
          const pick = () => onSelect(element.id);
          const base = common(
            element.id,
            element.x,
            element.y,
            'rotation' in element ? element.rotation : 0,
            source.width,
            source.height,
            element.kind === 'shape' && element.shape === 'line',
          );
          switch (element.kind) {
            case 'shape':
              return element.shape === 'rect' ? (
                <Rect
                  key={element.id}
                  {...base}
                  fill={element.fill}
                  stroke={element.stroke}
                  strokeWidth={element.stroke ? element.strokeWidth : 0}
                  onMouseDown={pick}
                  onTap={pick}
                />
              ) : (
                <Group key={element.id} {...base} onMouseDown={pick} onTap={pick}>
                  {/* Invisible box, at least 8 px thick: keeps the selection box above Konva's 1 px minimum for flat lines. */}
                  <Rect
                    x={-Math.max(0, 8 / scale - element.width) / 2}
                    y={-Math.max(0, 8 / scale - element.height) / 2}
                    width={Math.max(element.width, 8 / scale)}
                    height={Math.max(element.height, 8 / scale)}
                    fill="rgba(0,0,0,0)"
                    listening={false}
                  />
                  <Line
                    points={[0, 0, element.width, element.height]}
                    stroke={element.stroke ?? element.fill ?? '#000000'}
                    strokeWidth={Math.max(0.2, element.strokeWidth)}
                    hitStrokeWidth={Math.max(Math.max(0.2, element.strokeWidth), 14 / scale)}
                  />
                </Group>
              );
            case 'cover':
              return (
                <Group key={element.id} {...base} onMouseDown={pick} onTap={pick}>
                  <Rect width={element.width} height={element.height} fill="#e1e3e8" />
                  {cover ? (
                    <FitImage
                      image={cover}
                      width={element.width}
                      height={element.height}
                      fit={element.fit}
                      opacity={element.opacity}
                    />
                  ) : (
                    <Text
                      text={props.coverLabel}
                      width={element.width}
                      height={element.height}
                      align="center"
                      verticalAlign="middle"
                      fontSize={4}
                      fill="#6b7280"
                      listening={false}
                    />
                  )}
                </Group>
              );
            case 'image':
              return (
                <AssetImage
                  key={element.id}
                  element={element}
                  onSelectEl={pick}
                  commonProps={base}
                />
              );
            case 'text':
              return (
                <Group key={element.id} {...base} onMouseDown={pick} onTap={pick}>
                  <Rect
                    width={element.width}
                    height={element.height}
                    fill="rgba(59,130,246,0.04)"
                    stroke={selectedId === element.id ? undefined : 'rgba(59,130,246,0.35)'}
                    strokeWidth={0.2}
                    dash={[1, 1]}
                  />
                  <Text
                    text={props.textFor(element)}
                    width={element.width}
                    height={element.height}
                    fontSize={element.fontSize * PT_TO_MM}
                    fontFamily={previewFont}
                    fontStyle={element.fontWeight === 'bold' ? 'bold' : 'normal'}
                    fill={element.color}
                    align={element.align}
                    lineHeight={1.2}
                    wrap="word"
                    ellipsis
                    listening={false}
                  />
                </Group>
              );
          }
        })}
        <Group
          {...common(QR_ID, layout.qr.x, layout.qr.y, 0, layout.qr.size, layout.qr.size)}
          onMouseDown={() => onSelect(QR_ID)}
          onTap={() => onSelect(QR_ID)}
        >
          <Rect
            width={qrSize}
            height={qrSize}
            fill={layout.qr.background}
            stroke="#111827"
            strokeWidth={0.3}
          />
          <Rect
            x={qrSize * 0.12}
            y={qrSize * 0.12}
            width={qrSize * 0.76}
            height={qrSize * 0.76}
            fill={layout.qr.foreground}
            opacity={0.15}
            listening={false}
          />
          <Text
            text="QR"
            width={qrSize}
            height={qrSize}
            align="center"
            verticalAlign="middle"
            fontStyle="bold"
            fontSize={Math.max(3, qrSize * 0.22)}
            fill={layout.qr.foreground}
            listening={false}
          />
        </Group>
        <Transformer
          ref={trRef}
          rotateEnabled={selected !== undefined && selected !== 'qr' && selected !== 'shape'}
          keepRatio={selected === 'qr'}
          enabledAnchors={
            selected === 'qr'
              ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
              : selectedLine && selectedLine.height === 0
                ? ['middle-left', 'middle-right']
                : selectedLine && selectedLine.width === 0
                  ? ['top-center', 'bottom-center']
                  : undefined
          }
          boundBoxFunc={(oldBox, newBox) =>
            selectedLine
              ? Math.max(newBox.width, newBox.height) < 4
                ? oldBox
                : newBox
              : newBox.width < 1 || newBox.height < 1
                ? oldBox
                : newBox
          }
          anchorSize={7}
          borderStroke="#2563eb"
          anchorStroke="#2563eb"
        />
      </Layer>
    </Stage>
  );
}
