'use client';

import { SEAT_BLOCK_REASONS } from '@tix/shared';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SplitRowDialog } from '../dialogs';
import { patchSeats } from '../doc-ops';
import { type Option, PanelSection, SelectField } from '../fields';
import { COLORS, type Doc, selectOnly } from '../model';
import { moveToSection, splitRow } from '../row-ops';
import { SymbolPicker } from '../symbol-picker';
import { type Apply, type PanelProps } from './types';

// ─── Shared bits ────────────────────────────────────────────────────────────

export function useOptions() {
  const t = useTranslations('editor.options');
  return {
    numbering: (['ASCENDING', 'DESCENDING', 'ODD_EVEN_FROM_CENTER'] as const).map((v) => ({
      value: v,
      label: t(`numbering.${v}`),
    })),
    labelPlacement: (['START', 'END', 'BOTH', 'NONE'] as const).map((v) => ({
      value: v,
      label: t(`labelPlacement.${v}`),
    })),
    blockReasons: SEAT_BLOCK_REASONS.map((v) => ({ value: v, label: t(`blockReason.${v}`) })),
  };
}

export function categoryOptions(categories: PanelProps['categories']): Option[] {
  return categories.map((c) => ({ value: c.id, label: c.name }));
}

export function DeleteButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="destructive" size="sm" className="w-full" onClick={onClick}>
      <Trash2 /> {label}
    </Button>
  );
}

/** Target block selector + action that moves the selected rows / seats there. */
export function MoveToBlock({
  doc,
  selection,
  apply,
}: Pick<PanelProps, 'doc' | 'selection' | 'apply'>) {
  const t = useTranslations('editor');
  const blocks = doc.sections.filter((s) => s.type === 'SEATED');
  const current = new Set([
    ...doc.seats.filter((s) => selection.seats.has(s.id)).map((s) => s.sectionId),
    ...doc.rows.filter((r) => selection.rows.has(r.id)).map((r) => r.sectionId),
  ]);
  const [target, setTarget] = useState<string | null>(
    () => blocks.find((b) => !current.has(b.id))?.id ?? null,
  );
  if (blocks.length < 2) return null;
  return (
    <PanelSection title={t('panel.moveToBlock')}>
      <SelectField
        label={t('fields.targetBlock')}
        value={target}
        emptyLabel={t('options.choose')}
        options={blocks.map((b) => ({ value: b.id, label: b.name }))}
        onChange={setTarget}
        hint={t('hints.moveToBlock')}
      />
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={!target || (current.size === 1 && current.has(target))}
        onClick={() => target && apply((d) => moveToSection(d, selection, target))}
      >
        {t('actions.moveToBlock')}
      </Button>
    </PanelSection>
  );
}

/** Seat shape (library symbol) for one or many seats; null = plan default. */
export function SeatShapePicker({
  doc,
  seatIds,
  symbols,
  categories,
  apply,
}: Pick<PanelProps, 'doc' | 'symbols' | 'categories' | 'apply'> & {
  seatIds: ReadonlySet<string>;
}) {
  const t = useTranslations('editor');
  const seats = doc.seats.filter((s) => seatIds.has(s.id));
  const values = new Set(seats.map((s) => s.symbolId));
  const value = values.size === 1 ? [...values][0]! : null;
  const color =
    categories.find((c) => c.id === seats[0]?.priceCategoryId)?.color ?? COLORS.noCategory;
  const planDefault = doc.settings.defaultSeatSymbolId ?? null;
  return (
    <SymbolPicker
      label={t('fields.seatShape')}
      symbols={symbols}
      kind="SEAT"
      value={value}
      previewColor={color}
      noneLabel={planDefault ? t('symbols.planDefault') : t('symbols.circle')}
      hint={values.size > 1 ? t('hints.mixedShapes') : undefined}
      onChange={(symbolId) =>
        apply((d) =>
          patchSeats(d, seatIds, (s) => (s.symbolId === symbolId ? s : { ...s, symbolId })),
        )
      }
    />
  );
}

export function useSplit(doc: Doc, apply: Apply) {
  const [split, setSplit] = useState<{ rowId: string; firstPartSize: number } | null>(null);
  const dialog = split ? (
    <SplitRowDialog
      doc={doc}
      rowId={split.rowId}
      initialFirstPartSize={split.firstPartSize}
      onCancel={() => setSplit(null)}
      onConfirm={(values) => {
        const result = splitRow(
          doc,
          split.rowId,
          values.firstPartSize,
          values.label,
          values.sectionId,
        );
        if (result)
          apply(() => result.doc, undefined, selectOnly('rows', [split.rowId, result.newRowId]));
        setSplit(null);
      }}
    />
  ) : null;
  return {
    openSplit: (rowId: string, firstPartSize: number) => setSplit({ rowId, firstPartSize }),
    dialog,
  };
}
