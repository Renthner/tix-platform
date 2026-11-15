'use client';

import { type DocRow, type RowGeometry } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { deleteSelection, patchEntity, reflowRow, setRowCurveType } from '../doc-ops';
import { NumberField, PanelSection, SelectField, TextField } from '../fields';
import { EMPTY_SELECTION, selectOnly } from '../model';
import { resetRowLabels, rowSeatsInOrder } from '../row-ops';
import { SeatOrientationSection } from '../seat-orientation';
import { type PanelProps } from './types';
import { DeleteButton, MoveToBlock, useOptions, useSplit } from './shared';

export function RowPanel(props: PanelProps & { row: DocRow }) {
  const { doc, row, apply, select, selection } = props;
  const t = useTranslations('editor');
  const options = useOptions();
  const id = row.id;
  const seats = rowSeatsInOrder(doc, id);
  const { openSplit, dialog } = useSplit(doc, apply);
  const [startNumber, setStartNumber] = useState(() => {
    const numeric = seats.map((s) => Number(s.label)).filter((n) => Number.isInteger(n) && n >= 0);
    return numeric.length ? Math.min(...numeric) : 1;
  });
  const setGeometry = (patch: Partial<RowGeometry>, key: string, reflow = false) =>
    apply((d) => {
      const r = d.rows.find((x) => x.id === id);
      if (!r) return d;
      const next = patchEntity(d, 'rows', id, { geometry: { ...r.geometry, ...patch } });
      return reflow ? reflowRow(next, id, { relabel: true }) : next;
    }, `row:${id}:${key}`);
  const hasExplicitLabels = Boolean(row.geometry.labelStart || row.geometry.labelEnd);
  return (
    <>
      <PanelSection title={t('panel.row')}>
        <TextField
          label={t('fields.label')}
          value={row.label}
          maxLength={32}
          onChange={(label) =>
            apply((d) => patchEntity(d, 'rows', id, { label }), `row:${id}:label`)
          }
        />
        <NumberField
          label={t('fields.sortOrder')}
          hint={t('hints.sortOrder')}
          value={row.sortOrder}
          integer
          onChange={(v) =>
            v !== null &&
            apply((d) => patchEntity(d, 'rows', id, { sortOrder: v }), `row:${id}:sort`)
          }
        />
        <SelectField
          label={t('fields.curve')}
          value={row.geometry.curve.type}
          options={(['straight', 'arc'] as const).map((v) => ({
            value: v,
            label: t(`options.curve.${v}`),
          }))}
          onChange={(v) =>
            (v === 'straight' || v === 'arc') && apply((d) => setRowCurveType(d, id, v))
          }
        />
      </PanelSection>
      <PanelSection title={t('panel.rowLabels')}>
        <SelectField
          label={t('fields.labelPlacement')}
          value={row.geometry.labelPlacement}
          options={options.labelPlacement}
          onChange={(v) =>
            v && setGeometry({ labelPlacement: v as RowGeometry['labelPlacement'] }, 'placement')
          }
        />
        <p className="text-[11px] text-muted-foreground">{t('hints.labelHandles')}</p>
        {hasExplicitLabels && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => apply((d) => resetRowLabels(d, new Set([id])))}
          >
            {t('actions.resetLabels')}
          </Button>
        )}
      </PanelSection>
      <SeatOrientationSection doc={doc} rowIds={selection.rows} apply={apply} />
      <PanelSection title={t('panel.rowSeats')}>
        <NumberField
          label={t('fields.seatCount')}
          value={seats.length}
          integer
          min={1}
          max={500}
          onChange={(v) =>
            v !== null &&
            v !== seats.length &&
            apply((d) => reflowRow(d, id, { count: v }), `row:${id}:count`)
          }
        />
        <SelectField
          label={t('fields.numbering')}
          value={row.geometry.numbering}
          options={options.numbering}
          onChange={(v) =>
            v && setGeometry({ numbering: v as RowGeometry['numbering'] }, 'numbering', true)
          }
        />
        <NumberField
          label={t('fields.startNumber')}
          value={startNumber}
          integer
          min={0}
          max={100_000}
          onChange={(v) => v !== null && setStartNumber(v)}
        />
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => apply((d) => reflowRow(d, id, { relabel: true, startNumber }))}
          >
            {t('actions.renumber')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => apply((d) => reflowRow(d, id))}
            title={t('hints.reflow')}
          >
            {t('actions.reflow')}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('hints.rowHandles')}</p>
      </PanelSection>
      <MoveToBlock doc={doc} selection={selection} apply={apply} />
      <PanelSection title={t('panel.actions')}>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() =>
            select(
              selectOnly(
                'seats',
                seats.map((s) => s.id),
              ),
            )
          }
        >
          {t('actions.selectSeats', { count: seats.length })}
        </Button>
        {seats.length >= 2 && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => openSplit(id, Math.ceil(seats.length / 2))}
          >
            {t('actions.splitRow')}
          </Button>
        )}
        <DeleteButton
          label={t('actions.deleteRow')}
          onClick={() =>
            apply((d) => deleteSelection(d, selectOnly('rows', [id])), undefined, EMPTY_SELECTION)
          }
        />
      </PanelSection>
      {dialog}
    </>
  );
}
