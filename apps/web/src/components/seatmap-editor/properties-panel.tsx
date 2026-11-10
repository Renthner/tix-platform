'use client';

import {
  SEAT_BLOCK_REASONS,
  SPECIAL_SEAT_ICONS,
  SPECIAL_SEAT_LABEL_MODES,
  companionPartners,
  type DocElement,
  type DocEntrance,
  type DocRow,
  type DocSeat,
  type DocSection,
  type RowGeometry,
  type SeatBlockReason,
  type SpecialSeatLabel,
  type SpecialSeatLabelMode,
} from '@tix/shared';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SplitRowDialog } from './dialogs';
import { PlanCategoriesSection } from './plan-categories';
import {
  deleteSelection,
  patchEntity,
  patchSeats,
  reflowRow,
  renumberSeats,
  setRowCurveType,
  setSectionType,
} from './doc-ops';
import {
  ColorField,
  NumberField,
  PanelSection,
  SelectField,
  SwitchField,
  TextField,
  type Option,
} from './fields';
import {
  COLORS,
  EMPTY_SELECTION,
  selectOnly,
  selectionCount,
  soleKind,
  type Doc,
  type Selection,
} from './model';
import {
  alignRowLabels,
  moveToSection,
  resetRowLabels,
  rowSeatsInOrder,
  splitRow,
} from './row-ops';
import { SeatOrientationSection } from './seat-orientation';
import { SymbolPicker } from './symbol-picker';
import type { EditorSymbol } from './types';

type Apply = (update: (doc: Doc) => Doc, coalesceKey?: string, select?: Selection) => void;

interface PanelProps {
  doc: Doc;
  selection: Selection;
  /** Category assignment is available (event plans: price categories, master plans: plan categories). */
  isEventMap: boolean;
  /** Master plan: plan categories are edited in the plan panel. */
  planCategories?: boolean;
  categories: { id: string; name: string; color: string }[];
  symbols: EditorSymbol[];
  apply: Apply;
  select: (selection: Selection) => void;
}

export function PropertiesPanel(props: PanelProps) {
  const { doc, selection } = props;
  const kind = soleKind(selection);
  const count = selectionCount(selection);
  const single = kind && selection[kind].size === 1 ? [...selection[kind]][0]! : null;

  let content: ReactNode;
  if (count === 0) {
    content = <PlanPanel {...props} />;
  } else if (kind === 'sections' && single) {
    const section = doc.sections.find((s) => s.id === single);
    content = section ? <SectionPanel {...props} section={section} /> : null;
  } else if (kind === 'rows' && single) {
    const row = doc.rows.find((r) => r.id === single);
    content = row ? <RowPanel {...props} row={row} /> : null;
  } else if (kind === 'seats' && single) {
    const seat = doc.seats.find((s) => s.id === single);
    content = seat ? <SeatPanel {...props} seat={seat} /> : null;
  } else if (kind === 'elements' && single) {
    const element = doc.elements.find((e) => e.id === single);
    content = element ? <ElementPanel {...props} element={element} /> : null;
  } else if (kind === 'entrances' && single) {
    const entrance = doc.entrances.find((e) => e.id === single);
    content = entrance ? <EntrancePanel {...props} entrance={entrance} /> : null;
  } else {
    content = <BulkPanel {...props} />;
  }
  return <div className="flex flex-col">{content}</div>;
}

// ─── Shared bits ────────────────────────────────────────────────────────────

function useOptions() {
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

function categoryOptions(categories: PanelProps['categories']): Option[] {
  return categories.map((c) => ({ value: c.id, label: c.name }));
}

function DeleteButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="destructive" size="sm" className="w-full" onClick={onClick}>
      <Trash2 /> {label}
    </Button>
  );
}

/** Target block selector + action that moves the selected rows / seats there. */
function MoveToBlock({ doc, selection, apply }: Pick<PanelProps, 'doc' | 'selection' | 'apply'>) {
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
function SeatShapePicker({
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

// ─── Plan ───────────────────────────────────────────────────────────────────

/** Plan label of wheelchair spaces or companion seats (icon, number, short text, nothing). */
function SpecialSeatLabelField({
  kind,
  value,
  onChange,
}: {
  kind: 'wheelchair' | 'companion';
  value: SpecialSeatLabel | undefined;
  onChange: (value: SpecialSeatLabel) => void;
}) {
  const t = useTranslations('editor');
  const mode = value?.mode ?? 'ICON';
  const icon = SPECIAL_SEAT_ICONS[kind];
  return (
    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
      <SelectField
        label={t(`fields.${kind}Label`)}
        value={mode}
        options={SPECIAL_SEAT_LABEL_MODES.map((m) => ({
          value: m,
          label: t(`options.specialSeatLabel.${m}`, { icon }),
        }))}
        onChange={(m) =>
          m &&
          onChange({
            mode: m as SpecialSeatLabelMode,
            ...(m === 'TEXT' ? { text: value?.text || (kind === 'wheelchair' ? 'R' : 'B') } : {}),
          })
        }
      />
      {mode === 'TEXT' ? (
        <div className="w-16">
          <TextField
            label={t('fields.shortText')}
            value={value?.text ?? ''}
            maxLength={3}
            onChange={(text) => onChange({ mode: 'TEXT', text })}
          />
        </div>
      ) : (
        <span className="w-16" />
      )}
    </div>
  );
}

function PlanPanel({ doc, apply, symbols, planCategories }: PanelProps) {
  const t = useTranslations('editor');
  const s = doc.settings;
  const setSettings = (patch: Partial<Doc['settings']>, key: string) =>
    apply((d) => ({ ...d, settings: { ...d.settings, ...patch } }), `plan:${key}`);
  return (
    <>
      <PanelSection title={t('panel.plan')}>
        <TextField
          label={t('fields.name')}
          value={doc.name}
          maxLength={120}
          onChange={(name) => apply((d) => (d.name === name ? d : { ...d, name }), 'plan:name')}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('fields.canvasWidth')}
            value={doc.canvasWidth}
            integer
            min={100}
            max={100_000}
            onChange={(v) => v !== null && apply((d) => ({ ...d, canvasWidth: v }), 'plan:w')}
          />
          <NumberField
            label={t('fields.canvasHeight')}
            value={doc.canvasHeight}
            integer
            min={100}
            max={100_000}
            onChange={(v) => v !== null && apply((d) => ({ ...d, canvasHeight: v }), 'plan:h')}
          />
        </div>
      </PanelSection>
      {planCategories && <PlanCategoriesSection doc={doc} apply={apply} />}
      <PanelSection title={t('panel.display')}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('fields.gridSize')}
            value={s.gridSize}
            min={1}
            max={1000}
            onChange={(v) => v !== null && setSettings({ gridSize: v }, 'grid')}
          />
          <NumberField
            label={t('fields.seatRadius')}
            value={s.seatRadius}
            min={1}
            max={500}
            onChange={(v) => v !== null && setSettings({ seatRadius: v }, 'radius')}
          />
        </div>
        <SymbolPicker
          label={t('fields.defaultSeatShape')}
          symbols={symbols}
          kind="SEAT"
          value={s.defaultSeatSymbolId ?? null}
          previewColor={COLORS.noCategory}
          noneLabel={t('symbols.circle')}
          hint={t('hints.defaultSeatShape')}
          onChange={(defaultSeatSymbolId) => setSettings({ defaultSeatSymbolId }, 'seatShape')}
        />
        <SwitchField
          label={t('fields.snapToGrid')}
          checked={s.snapToGrid}
          onChange={(v) => setSettings({ snapToGrid: v }, 'snap')}
        />
        <SwitchField
          label={t('fields.showSeatNumbers')}
          checked={s.showSeatNumbers}
          onChange={(v) => setSettings({ showSeatNumbers: v }, 'numbers')}
        />
      </PanelSection>
      <PanelSection title={t('panel.specialSeats')}>
        <SpecialSeatLabelField
          kind="wheelchair"
          value={s.wheelchairLabel}
          onChange={(wheelchairLabel) => setSettings({ wheelchairLabel }, 'wheelchairLabel')}
        />
        <SpecialSeatLabelField
          kind="companion"
          value={s.companionLabel}
          onChange={(companionLabel) => setSettings({ companionLabel }, 'companionLabel')}
        />
        <p className="text-[11px] text-muted-foreground">{t('hints.specialSeatLabels')}</p>
      </PanelSection>
      <PanelSection title={t('panel.help')}>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {(
            ['select', 'pan', 'zoom', 'multi', 'row', 'delete', 'undo', 'nudge', 'save'] as const
          ).map((k) => (
            <li key={k}>{t(`help.${k}`)}</li>
          ))}
        </ul>
      </PanelSection>
    </>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

function SectionPanel({
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
  return (
    <>
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
            if (
              value === 'STANDING' &&
              seatIds.length > 0 &&
              !window.confirm(t('confirm.standingRemovesSeats', { count: seatIds.length }))
            ) {
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

// ─── Row ────────────────────────────────────────────────────────────────────

function useSplit(doc: Doc, apply: Apply) {
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

function RowPanel(props: PanelProps & { row: DocRow }) {
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

// ─── Seat ───────────────────────────────────────────────────────────────────

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
        <p className="text-[11px] text-amber-700">{t('hints.companionNoPartner')}</p>
      )}
    </>
  );
}

function SeatPanel(props: PanelProps & { seat: DocSeat }) {
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

// ─── Element ────────────────────────────────────────────────────────────────

function ElementPanel({
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

// ─── Entrance ───────────────────────────────────────────────────────────────

function EntrancePanel({ entrance, apply }: PanelProps & { entrance: DocEntrance }) {
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

// ─── Bulk / mixed selection ─────────────────────────────────────────────────

function BulkPanel(props: PanelProps) {
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
