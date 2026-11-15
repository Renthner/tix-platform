'use client';

import { companionPartners, type DocSeat, type SeatBlockReason } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { deleteSelection, patchEntity } from '../doc-ops';
import { NumberField, PanelSection, SelectField, SwitchField, TextField } from '../fields';
import { EMPTY_SELECTION, selectOnly } from '../model';
import { rowSeatsInOrder } from '../row-ops';
import { type PanelProps } from './types';
import {
  categoryOptions,
  DeleteButton,
  MoveToBlock,
  SeatShapePicker,
  useOptions,
  useSplit,
} from './shared';

/**
 * Wheelchair space a companion seat belongs to: automatic (directly adjacent wheelchair space
 * in the same row / at the same table) or an explicitly chosen one.
 */
function CompanionPartnerField({
  doc,
  seat,
  apply,
}: Pick<PanelProps, 'doc' | 'apply'> & { seat: DocSeat }) {
  const t = useTranslations('editor');
  const wheelchairSeats = doc.seats.filter((s) => s.isWheelchairSpace && s.id !== seat.id);
  const describe = (s: DocSeat) => {
    const section = doc.sections.find((x) => x.id === s.sectionId)?.name ?? '';
    const row = s.rowId ? doc.rows.find((r) => r.id === s.rowId)?.label : null;
    return [section, row ? `${t('fields.row')} ${row}` : null, `${t('fields.seat')} ${s.label}`]
      .filter(Boolean)
      .join(' · ');
  };
  // Automatic partner (same rule as the shop).
  const automatic = companionPartners(
    doc.seats.map((s) => ({
      id: s.id,
      parentId: s.rowId ?? s.tableElementId,
      position: s.position,
      isWheelchairSpace: s.isWheelchairSpace,
      isCompanionSeat: s.id === seat.id,
      companionOfSeatId: null,
    })),
  ).get(seat.id);
  const autoLabel = automatic?.length
    ? t('options.companionAuto', {
        seats: automatic
          .map((id) => doc.seats.find((s) => s.id === id))
          .filter((s): s is DocSeat => !!s)
          .map(describe)
          .join(', '),
      })
    : t('options.companionAutoNone');
  return (
    <>
      <SelectField
        label={t('fields.companionOf')}
        value={seat.companionOfSeatId}
        emptyLabel={autoLabel}
        options={wheelchairSeats.map((s) => ({ value: s.id, label: describe(s) }))}
        onChange={(v) =>
          apply(
            (d) => patchEntity(d, 'seats', seat.id, { companionOfSeatId: v ? v : null }),
            `seat:${seat.id}:companionOf`,
          )
        }
      />
      {!seat.companionOfSeatId && !automatic?.length && (
        <p className="text-[11px] text-warning">{t('hints.companionNoPartner')}</p>
      )}
    </>
  );
}

export function SeatPanel(props: PanelProps & { seat: DocSeat }) {
  const { doc, seat, isEventMap, categories, apply, select, selection } = props;
  const t = useTranslations('editor');
  const options = useOptions();
  const id = seat.id;
  const set = (patch: Partial<DocSeat>, key: string) =>
    apply((d) => patchEntity(d, 'seats', id, patch), `seat:${id}:${key}`);
  const row = seat.rowId ? doc.rows.find((r) => r.id === seat.rowId) : null;
  const rowSeats = row ? rowSeatsInOrder(doc, row.id) : [];
  const indexInRow = rowSeats.findIndex((s) => s.id === id);
  const section = doc.sections.find((s) => s.id === seat.sectionId);
  const { openSplit, dialog } = useSplit(doc, apply);
  return (
    <>
      <PanelSection title={t('panel.seat')}>
        <p className="text-xs text-muted-foreground">
          {section?.name}
          {row ? ` · ${t('fields.row')} ${row.label}` : ''}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label={t('fields.seatNumber')}
            value={seat.label}
            maxLength={16}
            onChange={(label) => set({ label }, 'label')}
          />
          {(seat.rowId || seat.tableElementId) && (
            <NumberField
              label={t('fields.position')}
              value={seat.position}
              integer
              onChange={(v) => v !== null && set({ position: v }, 'position')}
            />
          )}
        </div>
        {isEventMap && (
          <SelectField
            label={t('fields.priceCategory')}
            value={seat.priceCategoryId}
            emptyLabel={t('options.none')}
            options={categoryOptions(categories)}
            onChange={(priceCategoryId) => set({ priceCategoryId }, 'category')}
          />
        )}
        <SeatShapePicker {...props} seatIds={selection.seats} />
        {!seat.rowId && (
          <NumberField
            label={t('fields.rotation')}
            hint={t('hints.seatRotation')}
            value={seat.rotation}
            min={-360}
            max={360}
            step={5}
            onChange={(v) => v !== null && set({ rotation: v }, 'rotation')}
          />
        )}
        <NumberField
          label={t('fields.rank')}
          hint={t('hints.rank')}
          value={seat.bestAvailableRank}
          integer
          min={0}
          allowEmpty
          onChange={(bestAvailableRank) => set({ bestAvailableRank }, 'rank')}
        />
      </PanelSection>
      <PanelSection title={t('panel.features')}>
        <SwitchField
          label={t('fields.wheelchair')}
          checked={seat.isWheelchairSpace}
          onChange={(v) => set({ isWheelchairSpace: v }, 'wc')}
        />
        <SwitchField
          label={t('fields.companion')}
          checked={seat.isCompanionSeat}
          onChange={(v) =>
            set(
              v ? { isCompanionSeat: true } : { isCompanionSeat: false, companionOfSeatId: null },
              'comp',
            )
          }
        />
        {seat.isCompanionSeat && <CompanionPartnerField doc={doc} seat={seat} apply={apply} />}
        <SwitchField
          label={t('fields.restrictedView')}
          checked={seat.hasRestrictedView}
          onChange={(v) => set({ hasRestrictedView: v }, 'view')}
        />
      </PanelSection>
      <PanelSection title={t('panel.blocking')}>
        <SelectField
          label={t('fields.blockReason')}
          value={seat.blockReason}
          emptyLabel={t('options.notBlocked')}
          options={options.blockReasons}
          onChange={(v) =>
            set(
              { blockReason: v as SeatBlockReason | null, blockNote: v ? seat.blockNote : null },
              'block',
            )
          }
        />
        {seat.blockReason && (
          <TextField
            label={t('fields.blockNote')}
            value={seat.blockNote ?? ''}
            maxLength={500}
            onChange={(v) => set({ blockNote: v || null }, 'note')}
          />
        )}
      </PanelSection>
      <MoveToBlock doc={doc} selection={selection} apply={apply} />
      <PanelSection title={t('panel.actions')}>
        {seat.rowId && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => select(selectOnly('rows', [seat.rowId!]))}
          >
            {t('actions.selectRow')}
          </Button>
        )}
        {row && indexInRow >= 0 && indexInRow < rowSeats.length - 1 && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => openSplit(row.id, indexInRow + 1)}
          >
            {t('actions.splitAfterSeat', { seat: seat.label })}
          </Button>
        )}
        <DeleteButton
          label={t('actions.deleteSeat')}
          onClick={() =>
            apply((d) => deleteSelection(d, selectOnly('seats', [id])), undefined, EMPTY_SELECTION)
          }
        />
      </PanelSection>
      {dialog}
    </>
  );
}
