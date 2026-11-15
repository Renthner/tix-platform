'use client';

import type { TicketLayoutElement } from '@tix/shared';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  ImagePlus,
  Image as ImageIcon,
  Minus,
  QrCode,
  Square,
  TextCursorInput,
  Trash2,
  Type,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode, RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { QR_ID } from '../canvas';
import {
  newCoverElement,
  newFieldElement,
  newLineElement,
  newRectElement,
  newStaticTextElement,
} from './model';

const HEADING = 'text-xs font-semibold tracking-wide text-muted-foreground uppercase';

export function ToolsPanel({
  pageWidthMm,
  hasSelectedElement,
  uploadRef,
  addElement,
  onUpload,
  selectQr,
  duplicate,
  move,
  removeSelected,
}: {
  pageWidthMm: number;
  hasSelectedElement: boolean;
  uploadRef: RefObject<HTMLInputElement | null>;
  addElement: (element: TicketLayoutElement) => void;
  onUpload: (file: File | undefined) => void;
  selectQr: (id: string) => void;
  duplicate: () => void;
  move: (delta: -1 | 1) => void;
  removeSelected: () => void;
}) {
  const t = useTranslations('ticketDesigner');
  const tool = (icon: ReactNode, label: string, onClick: () => void, disabled = false) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="justify-start gap-2"
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {label}
    </Button>
  );
  const noSelection = !hasSelectedElement;
  return (
    <div className="flex flex-col gap-2">
      <div className={HEADING}>{t('tools.add')}</div>
      {tool(<Type className="size-4" />, t('tools.field'), () => addElement(newFieldElement()))}
      {tool(<TextCursorInput className="size-4" />, t('tools.staticText'), () =>
        addElement(newStaticTextElement(t('tools.staticDefault'))),
      )}
      {tool(<Square className="size-4" />, t('tools.rect'), () => addElement(newRectElement()))}
      {tool(<Minus className="size-4" />, t('tools.line'), () => addElement(newLineElement()))}
      {tool(<ImageIcon className="size-4" />, t('tools.cover'), () =>
        addElement(newCoverElement(pageWidthMm)),
      )}
      {tool(<ImagePlus className="size-4" />, t('tools.image'), () => uploadRef.current?.click())}
      <input
        ref={uploadRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => onUpload(e.target.files?.[0])}
      />
      <div className={`mt-2 ${HEADING}`}>{t('tools.selection')}</div>
      {tool(<QrCode className="size-4" />, t('tools.selectQr'), () => selectQr(QR_ID))}
      {tool(<Copy className="size-4" />, t('tools.duplicate'), duplicate, noSelection)}
      {tool(<ArrowUp className="size-4" />, t('tools.forward'), () => move(1), noSelection)}
      {tool(<ArrowDown className="size-4" />, t('tools.backward'), () => move(-1), noSelection)}
      {tool(<Trash2 className="size-4" />, t('tools.delete'), removeSelected, noSelection)}
      <p className="text-xs text-muted-foreground">{t('tools.keys')}</p>
    </div>
  );
}
