import { DEFAULT_TICKET_PAGE_MM, type TicketLayoutElement } from '@tix/shared';
import type { Draft } from './types';

export const HISTORY_LIMIT = 60;
export const uid = () => Math.random().toString(36).slice(2, 10);
export const round = (n: number) => Math.round(n * 100) / 100;

export const PRESETS = [
  { key: 'default', width: DEFAULT_TICKET_PAGE_MM.width, height: DEFAULT_TICKET_PAGE_MM.height },
  { key: 'a6', width: 148, height: 105 },
  { key: 'wide', width: 210, height: 99 },
  { key: 'a5', width: 210, height: 148 },
  { key: 'portrait', width: 100, height: 210 },
] as const;

export const clampPageMm = (value: number) => Math.min(2000, Math.max(20, value));

export function setPageSize(d: Draft, width: number, height: number): Draft {
  return { ...d, pageWidthMm: clampPageMm(width), pageHeightMm: clampPageMm(height) };
}

/** Cover band at the page width with the cover's aspect; everything below moves with it. */
export function matchCoverDraft(d: Draft, coverAspect: number): Draft {
  const width = d.pageWidthMm;
  const band = round(width / coverAspect);
  const cover = d.layout.elements.find((e) => e.kind === 'cover');
  const oldBand = cover ? cover.y + cover.height : 0;
  const delta = round(band - oldBand);
  const shift = <T extends { y: number }>(item: T): T => ({
    ...item,
    y: Math.max(0, round(item.y + delta)),
  });
  const elements = d.layout.elements.map((e) =>
    e.id === cover?.id
      ? ({ ...e, x: 0, y: 0, width, height: band } as TicketLayoutElement)
      : shift(e),
  );
  return {
    ...d,
    pageHeightMm: clampPageMm(round(d.pageHeightMm + delta)),
    layout: {
      ...d.layout,
      qr: shift(d.layout.qr),
      elements: cover
        ? elements
        : [
            {
              kind: 'cover',
              id: uid(),
              x: 0,
              y: 0,
              width,
              height: band,
              fit: 'cover',
              opacity: 1,
            } as TicketLayoutElement,
            ...elements,
          ],
    },
  };
}

// ── element factories (defaults of the "add" tools) ─────────────────────────

export const newFieldElement = (): TicketLayoutElement => ({
  kind: 'text',
  id: uid(),
  field: 'EVENT_TITLE',
  x: 10,
  y: 10,
  width: 80,
  height: 8,
  rotation: 0,
  fontFamily: 'Noto Sans',
  fontSize: 14,
  fontWeight: 'normal',
  color: '#111111',
  align: 'left',
  uppercase: false,
});

export const newStaticTextElement = (text: string): TicketLayoutElement => ({
  kind: 'text',
  id: uid(),
  field: 'STATIC_TEXT',
  text,
  x: 10,
  y: 10,
  width: 80,
  height: 8,
  rotation: 0,
  fontFamily: 'Noto Sans',
  fontSize: 10,
  fontWeight: 'normal',
  color: '#111111',
  align: 'left',
  uppercase: false,
});

export const newRectElement = (): TicketLayoutElement => ({
  kind: 'shape',
  id: uid(),
  shape: 'rect',
  x: 10,
  y: 10,
  width: 40,
  height: 10,
  fill: '#E5E7EB',
  strokeWidth: 0.3,
});

export const newLineElement = (): TicketLayoutElement => ({
  kind: 'shape',
  id: uid(),
  shape: 'line',
  x: 10,
  y: 10,
  width: 60,
  height: 0,
  stroke: '#9CA3AF',
  strokeWidth: 0.3,
});

export const newCoverElement = (pageWidthMm: number): TicketLayoutElement => ({
  kind: 'cover',
  id: uid(),
  x: 0,
  y: 0,
  width: pageWidthMm,
  height: round(pageWidthMm * 0.3),
  fit: 'cover',
  opacity: 1,
});

export const newImageElement = (
  assetId: string,
  ratio: number,
  width = 30,
): TicketLayoutElement => ({
  kind: 'image',
  id: uid(),
  assetId,
  x: 10,
  y: 10,
  width,
  height: round(width / ratio),
  rotation: 0,
  opacity: 1,
});
