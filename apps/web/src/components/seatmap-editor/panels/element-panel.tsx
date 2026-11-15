'use client';

import { type DocElement, type DocEntrance } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { deleteSelection, patchEntity } from '../doc-ops';
import { ColorField, NumberField, PanelSection, SwitchField, TextField } from '../fields';
import { EMPTY_SELECTION, selectOnly } from '../model';
import { SymbolPicker } from '../symbol-picker';
import { type PanelProps } from './types';
import { DeleteButton } from './shared';

export function ElementPanel({
  doc,
  element,
  apply,
  select,
  symbols,
}: PanelProps & { element: DocElement }) {
  const t = useTranslations('editor');
  const id = element.id;
  const set = (patch: Partial<DocElement>, key: string) =>
    apply((d) => patchEntity(d, 'elements', id, patch), `element:${id}:${key}`);
  const setStyle = (patch: Partial<DocElement['style']>, key: string) =>
    apply((d) => {
      const e = d.elements.find((x) => x.id === id);
      return e ? patchEntity(d, 'elements', id, { style: { ...e.style, ...patch } }) : d;
    }, `element:${id}:style:${key}`);
  const g = element.geometry;
  const tableSeats =
    element.type === 'TABLE' ? doc.seats.filter((s) => s.tableElementId === id) : [];
  const supportsSymbol = element.type !== 'IMAGE' && g.type !== 'path';
  return (
    <>
      <PanelSection title={t('panel.element')}>
        <Badge variant="secondary">{t(`options.elementType.${element.type}`)}</Badge>
        <TextField
          label={t('fields.label')}
          value={element.label ?? ''}
          maxLength={200}
          onChange={(v) => set({ label: v || null }, 'label')}
        />
        {(g.type === 'rect' || g.type === 'point') && (
          <NumberField
            label={t('fields.rotation')}
            value={g.rotation}
            min={-360}
            max={360}
            onChange={(v) => v !== null && set({ geometry: { ...g, rotation: v } }, 'rotation')}
          />
        )}
        <NumberField
          label={t('fields.zIndex')}
          value={element.zIndex}
          integer
          onChange={(v) => v !== null && set({ zIndex: v }, 'z')}
        />
      </PanelSection>
      {supportsSymbol && (
        <PanelSection title={t('panel.symbol')}>
          <SymbolPicker
            label={t('fields.symbol')}
            symbols={symbols}
            kind="ELEMENT"
            value={element.style.symbolId ?? null}
            previewColor={element.style.symbolColor ?? '#334155'}
            noneLabel={t('options.none')}
            onChange={(symbolId) => setStyle({ symbolId: symbolId ?? undefined }, 'symbol')}
          />
          {element.style.symbolId && (
            <>
              <ColorField
                label={t('fields.symbolColor')}
                value={element.style.symbolColor ?? null}
                allowEmpty
                emptyLabel={t('options.automatic')}
                onChange={(v) => setStyle({ symbolColor: v ?? undefined }, 'symbolColor')}
              />
              <NumberField
                label={t('fields.symbolSize')}
                hint={t('hints.symbolSize')}
                value={element.style.symbolSize ?? null}
                min={1}
                max={10_000}
                allowEmpty
                onChange={(v) => setStyle({ symbolSize: v ?? undefined }, 'symbolSize')}
              />
            </>
          )}
          {element.type === 'FACILITY' && (
            <TextField
              label={t('fields.icon')}
              hint={t('hints.icon')}
              value={element.style.icon ?? ''}
              maxLength={64}
              onChange={(v) => setStyle({ icon: v || undefined }, 'icon')}
            />
          )}
        </PanelSection>
      )}
      <PanelSection title={t('panel.style')}>
        <ColorField
          label={t('fields.fill')}
          value={element.style.fill ?? null}
          allowEmpty
          emptyLabel={t('options.automatic')}
          onChange={(v) => setStyle({ fill: v ?? undefined }, 'fill')}
        />
        <ColorField
          label={t('fields.stroke')}
          value={element.style.stroke ?? null}
          allowEmpty
          emptyLabel={t('options.automatic')}
          onChange={(v) => setStyle({ stroke: v ?? undefined }, 'stroke')}
        />
        <ColorField
          label={t('fields.textColor')}
          value={element.style.textColor ?? null}
          allowEmpty
          emptyLabel={t('options.automatic')}
          onChange={(v) => setStyle({ textColor: v ?? undefined }, 'text')}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('fields.fontSize')}
            value={element.style.fontSize ?? null}
            min={1}
            max={500}
            allowEmpty
            onChange={(v) => setStyle({ fontSize: v ?? undefined }, 'font')}
          />
          <NumberField
            label={t('fields.strokeWidth')}
            value={element.style.strokeWidth ?? null}
            min={0}
            max={1000}
            allowEmpty
            onChange={(v) => setStyle({ strokeWidth: v ?? undefined }, 'sw')}
          />
        </div>
        <SwitchField
          label={t('fields.bold')}
          checked={element.style.fontWeight === 'bold'}
          onChange={(v) => setStyle({ fontWeight: v ? 'bold' : undefined }, 'bold')}
        />
      </PanelSection>
      <PanelSection title={t('panel.actions')}>
        {tableSeats.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              select(
                selectOnly(
                  'seats',
                  tableSeats.map((s) => s.id),
                ),
              )
            }
          >
            {t('actions.selectSeats', { count: tableSeats.length })}
          </Button>
        )}
        <DeleteButton
          label={t('actions.deleteElement')}
          onClick={() =>
            apply(
              (d) => deleteSelection(d, selectOnly('elements', [id])),
              undefined,
              EMPTY_SELECTION,
            )
          }
        />
      </PanelSection>
    </>
  );
}

export function EntrancePanel({ entrance, apply }: PanelProps & { entrance: DocEntrance }) {
  const t = useTranslations('editor');
  const id = entrance.id;
  return (
    <>
      <PanelSection title={t('panel.entrance')}>
        <TextField
          label={t('fields.name')}
          value={entrance.name}
          maxLength={120}
          onChange={(name) =>
            apply((d) => patchEntity(d, 'entrances', id, { name }), `entrance:${id}:name`)
          }
        />
        <TextField
          label={t('fields.code')}
          hint={t('hints.entranceCode')}
          value={entrance.code}
          maxLength={16}
          onChange={(code) =>
            apply((d) => patchEntity(d, 'entrances', id, { code }), `entrance:${id}:code`)
          }
        />
      </PanelSection>
      <PanelSection title={t('panel.actions')}>
        <DeleteButton
          label={t('actions.deleteEntrance')}
          onClick={() =>
            apply(
              (d) => deleteSelection(d, selectOnly('entrances', [id])),
              undefined,
              EMPTY_SELECTION,
            )
          }
        />
      </PanelSection>
    </>
  );
}
