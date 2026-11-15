'use client';

import { type DocSection } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { deleteSelection, patchEntity, patchSeats, setSectionType } from '../doc-ops';
import {
  ColorField,
  NumberField,
  PanelSection,
  SelectField,
  SwitchField,
  TextField,
} from '../fields';
import { EMPTY_SELECTION, selectOnly } from '../model';
import { type PanelProps } from './types';
import { categoryOptions, DeleteButton } from './shared';

export function SectionPanel({
  doc,
  section,
  isEventMap,
  categories,
  apply,
  select,
}: PanelProps & { section: DocSection }) {
  const t = useTranslations('editor');
  const id = section.id;
  const set = (patch: Partial<DocSection>, key: string) =>
    apply((d) => patchEntity(d, 'sections', id, patch), `section:${id}:${key}`);
  const seatIds = doc.seats.filter((s) => s.sectionId === id).map((s) => s.id);
  const [confirmStanding, setConfirmStanding] = useState(false);
  return (
    <>
      <ConfirmDialog
        open={confirmStanding}
        onOpenChange={setConfirmStanding}
        description={t('confirm.standingRemovesSeats', { count: seatIds.length })}
        confirmLabel={t('confirm.standingConfirm')}
        onConfirm={() => apply((d) => setSectionType(d, id, 'STANDING'))}
      />
      <PanelSection title={t('panel.section')}>
        <Badge variant="secondary">{t(`options.sectionType.${section.type}`)}</Badge>
        <TextField
          label={t('fields.name')}
          value={section.name}
          maxLength={120}
          onChange={(name) => set({ name }, 'name')}
        />
        <TextField
          label={t('fields.ticketLabel')}
          hint={t('hints.ticketLabel')}
          value={section.ticketLabel}
          maxLength={120}
          onChange={(ticketLabel) => set({ ticketLabel }, 'ticketLabel')}
        />
        <SelectField
          label={t('fields.type')}
          value={section.type}
          options={(['SEATED', 'STANDING'] as const).map((v) => ({
            value: v,
            label: t(`options.sectionType.${v}`),
          }))}
          onChange={(value) => {
            if (value !== 'SEATED' && value !== 'STANDING') return;
            if (value === 'STANDING' && seatIds.length > 0) {
              setConfirmStanding(true);
              return;
            }
            apply((d) => setSectionType(d, id, value));
          }}
        />
        {section.type === 'STANDING' && (
          <NumberField
            label={t('fields.capacity')}
            value={section.capacity}
            integer
            min={0}
            max={1_000_000}
            onChange={(v) => v !== null && set({ capacity: v }, 'capacity')}
          />
        )}
        <ColorField
          label={t('fields.color')}
          value={section.color}
          allowEmpty
          emptyLabel={t('options.automatic')}
          onChange={(color) => set({ color }, 'color')}
        />
        <SelectField
          label={t('fields.entrance')}
          value={section.entranceId}
          emptyLabel={t('options.none')}
          options={doc.entrances.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }))}
          onChange={(entranceId) => set({ entranceId }, 'entrance')}
        />
        {isEventMap && (
          <SelectField
            label={
              section.type === 'STANDING' ? t('fields.priceCategory') : t('fields.defaultCategory')
            }
            hint={section.type === 'SEATED' ? t('hints.defaultCategory') : undefined}
            value={section.priceCategoryId}
            emptyLabel={t('options.none')}
            options={categoryOptions(categories)}
            onChange={(priceCategoryId) => set({ priceCategoryId }, 'category')}
          />
        )}
        {isEventMap &&
          section.type === 'SEATED' &&
          section.priceCategoryId &&
          seatIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                apply((d) =>
                  patchSeats(d, new Set(seatIds), (s) =>
                    s.priceCategoryId === section.priceCategoryId
                      ? s
                      : { ...s, priceCategoryId: section.priceCategoryId },
                  ),
                )
              }
            >
              {t('actions.applyCategoryToSeats', { count: seatIds.length })}
            </Button>
          )}
      </PanelSection>
      <PanelSection title={t('panel.visibility')}>
        <SwitchField
          label={t('fields.showNameOnMap')}
          hint={t('hints.showNameOnMap')}
          checked={section.showNameOnMap}
          onChange={(showNameOnMap) => set({ showNameOnMap }, 'showName')}
        />
        <SwitchField
          label={t('fields.showLabelOnTicket')}
          hint={t('hints.showLabelOnTicket')}
          checked={section.showLabelOnTicket}
          onChange={(showLabelOnTicket) => set({ showLabelOnTicket }, 'showLabel')}
        />
      </PanelSection>
      <PanelSection title={t('panel.sales')}>
        <SwitchField
          label={t('fields.active')}
          checked={section.isActive}
          onChange={(isActive) => set({ isActive }, 'active')}
          hint={t('hints.active')}
        />
        {section.type === 'SEATED' && (
          <>
            <SwitchField
              label={t('fields.bestAvailableEnabled')}
              checked={section.isBestAvailableEnabled}
              onChange={(isBestAvailableEnabled) => set({ isBestAvailableEnabled }, 'ba')}
            />
            <NumberField
              label={t('fields.bestAvailablePriority')}
              hint={t('hints.bestAvailablePriority')}
              value={section.bestAvailablePriority}
              integer
              min={0}
              max={1_000_000}
              onChange={(v) => v !== null && set({ bestAvailablePriority: v }, 'priority')}
            />
          </>
        )}
      </PanelSection>
      <PanelSection title={t('panel.actions')}>
        {seatIds.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => select(selectOnly('seats', seatIds))}
          >
            {t('actions.selectSeats', { count: seatIds.length })}
          </Button>
        )}
        <DeleteButton
          label={t('actions.deleteSection')}
          onClick={() =>
            apply(
              (d) => deleteSelection(d, selectOnly('sections', [id])),
              undefined,
              EMPTY_SELECTION,
            )
          }
        />
      </PanelSection>
    </>
  );
}
