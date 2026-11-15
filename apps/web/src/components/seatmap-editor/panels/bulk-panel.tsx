'use client';

import { type SeatBlockReason } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { deleteSelection, patchSeats, renumberSeats } from '../doc-ops';
import { NumberField, PanelSection, SelectField, TextField } from '../fields';
import { EMPTY_SELECTION } from '../model';
import { alignRowLabels, resetRowLabels } from '../row-ops';
import { SeatOrientationSection } from '../seat-orientation';
import { type PanelProps } from './types';
import { DeleteButton, MoveToBlock, SeatShapePicker, useOptions } from './shared';

export function BulkPanel(props: PanelProps) {
  const { selection, isEventMap, categories, apply, doc } = props;
  const t = useTranslations('editor');
  const options = useOptions();
  const seats = selection.seats;
  const rows = selection.rows;
  const [reason, setReason] = useState<SeatBlockReason>('TECHNICAL');
  const [note, setNote] = useState('');
  const [start, setStart] = useState(1);
  const setFlag = (
    flag: 'isWheelchairSpace' | 'isCompanionSeat' | 'hasRestrictedView',
    value: boolean,
  ) => apply((d) => patchSeats(d, seats, (s) => (s[flag] === value ? s : { ...s, [flag]: value })));
  const explicitLabels = doc.rows.some(
    (r) => rows.has(r.id) && (r.geometry.labelStart || r.geometry.labelEnd),
  );

  return (
    <>
      <PanelSection title={t('panel.selection')}>
        <ul className="space-y-0.5 text-sm">
          {(['seats', 'rows', 'sections', 'elements', 'entrances'] as const)
            .filter((k) => selection[k].size > 0)
            .map((k) => (
              <li key={k}>{t(`bulk.${k}`, { count: selection[k].size })}</li>
            ))}
        </ul>
      </PanelSection>
      {rows.size > 0 && (
        <PanelSection title={t('panel.rowLabels')}>
          {rows.size >= 2 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => apply((d) => alignRowLabels(d, rows))}
            >
              {t('actions.alignLabels')}
            </Button>
          )}
          {rows.size >= 2 && (
            <p className="text-[11px] text-muted-foreground">{t('hints.alignLabels')}</p>
          )}
          {explicitLabels && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => apply((d) => resetRowLabels(d, rows))}
            >
              {t('actions.resetLabels')}
            </Button>
          )}
        </PanelSection>
      )}
      {rows.size > 0 && <SeatOrientationSection doc={doc} rowIds={rows} apply={apply} />}
      {(seats.size > 0 || rows.size > 0) && (
        <MoveToBlock doc={doc} selection={selection} apply={apply} />
      )}
      {seats.size > 0 && (
        <>
          {isEventMap && (
            <PanelSection title={t('panel.priceCategory')}>
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <Button
                    key={c.id}
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      apply((d) =>
                        patchSeats(d, seats, (s) =>
                          s.priceCategoryId === c.id ? s : { ...s, priceCategoryId: c.id },
                        ),
                      )
                    }
                  >
                    <span
                      className="inline-block size-3 rounded-full"
                      style={{ background: c.color }}
                    />
                    {c.name}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    apply((d) =>
                      patchSeats(d, seats, (s) =>
                        s.priceCategoryId === null ? s : { ...s, priceCategoryId: null },
                      ),
                    )
                  }
                >
                  {t('actions.clearCategory')}
                </Button>
              </div>
              {categories.length === 0 && (
                <p className="text-xs text-muted-foreground">{t('hints.noCategories')}</p>
              )}
            </PanelSection>
          )}
          <PanelSection title={t('panel.seatShape')}>
            <SeatShapePicker {...props} seatIds={seats} />
          </PanelSection>
          <PanelSection title={t('panel.blocking')}>
            <SelectField
              label={t('fields.blockReason')}
              value={reason}
              options={options.blockReasons}
              onChange={(v) => v && setReason(v as SeatBlockReason)}
            />
            <TextField
              label={t('fields.blockNote')}
              value={note}
              maxLength={500}
              onChange={setNote}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  apply((d) =>
                    patchSeats(d, seats, (s) => ({
                      ...s,
                      blockReason: reason,
                      blockNote: note || null,
                    })),
                  )
                }
              >
                {t('actions.block')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  apply((d) =>
                    patchSeats(d, seats, (s) =>
                      s.blockReason === null ? s : { ...s, blockReason: null, blockNote: null },
                    ),
                  )
                }
              >
                {t('actions.unblock')}
              </Button>
            </div>
          </PanelSection>
          <PanelSection title={t('panel.features')}>
            {(
              [
                ['isWheelchairSpace', 'wheelchair'],
                ['isCompanionSeat', 'companion'],
                ['hasRestrictedView', 'restrictedView'],
              ] as const
            ).map(([flag, label]) => (
              <div key={flag} className="flex items-center justify-between gap-2 text-sm">
                <span>{t(`fields.${label}`)}</span>
                <div className="flex gap-1">
                  <Button variant="outline" size="xs" onClick={() => setFlag(flag, true)}>
                    {t('actions.set')}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setFlag(flag, false)}>
                    {t('actions.clear')}
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() =>
                apply((d) =>
                  patchSeats(d, seats, (s) =>
                    s.bestAvailableRank === null ? s : { ...s, bestAvailableRank: null },
                  ),
                )
              }
            >
              {t('actions.clearRank')}
            </Button>
          </PanelSection>
          <PanelSection title={t('panel.numbering')}>
            <NumberField
              label={t('fields.startNumber')}
              value={start}
              integer
              min={0}
              max={100_000}
              onChange={(v) => v !== null && setStart(v)}
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => apply((d) => renumberSeats(d, seats, start))}
            >
              {t('actions.renumberSelected')}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t('hints.renumber')}</p>
          </PanelSection>
        </>
      )}
      <PanelSection title={t('panel.actions')}>
        <DeleteButton
          label={t('actions.deleteSelection')}
          onClick={() => apply((d) => deleteSelection(d, selection), undefined, EMPTY_SELECTION)}
        />
      </PanelSection>
    </>
  );
}
