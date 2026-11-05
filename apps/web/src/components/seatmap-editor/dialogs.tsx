'use client';

import { seatCountForSpacing, type DocSection, type RowGeometry } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { rowLabelsFor, seatCountFor, type RowSpec, type TableSpec } from './doc-ops';
import { ColorField, NumberField, SelectField, SwitchField, TextField } from './fields';
import type { Doc } from './model';
import { rowSeatsInOrder, uniqueRowLabel } from './row-ops';

/** Creation dialogs opened after the user finished drawing on the canvas. */

function FormDialog({
  open,
  title,
  description,
  submitLabel,
  disabled,
  onCancel,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  submitLabel: string;
  disabled?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const tc = useTranslations('common.actions');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!disabled) onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-3">{children}</div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={disabled}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const seatedOptions = (doc: Doc) =>
  doc.sections.filter((s) => s.type === 'SEATED').map((s) => ({ value: s.id, label: s.name }));

// ─── Section ────────────────────────────────────────────────────────────────

export interface SectionValues {
  type: DocSection['type'];
  name: string;
  ticketLabel: string;
  capacity: number;
  color: string | null;
}

export function SectionDialog({
  doc,
  onCancel,
  onConfirm,
}: {
  doc: Doc;
  onCancel: () => void;
  onConfirm: (values: SectionValues) => void;
}) {
  const t = useTranslations('editor');
  const initialName = t('defaults.sectionName', { n: doc.sections.length + 1 });
  const [values, setValues] = useState<SectionValues>({
    type: 'SEATED',
    name: initialName,
    ticketLabel: initialName,
    capacity: 100,
    color: null,
  });
  const [labelTouched, setLabelTouched] = useState(false);
  const nameTaken = doc.sections.some(
    (s) => s.name.toLowerCase() === values.name.trim().toLowerCase(),
  );
  const valid = values.name.trim() !== '' && values.ticketLabel.trim() !== '' && !nameTaken;
  return (
    <FormDialog
      open
      title={t('dialogs.section.title')}
      submitLabel={t('dialogs.create')}
      disabled={!valid}
      onCancel={onCancel}
      onSubmit={() =>
        onConfirm({ ...values, name: values.name.trim(), ticketLabel: values.ticketLabel.trim() })
      }
    >
      <SelectField
        label={t('fields.type')}
        value={values.type}
        options={(['SEATED', 'STANDING'] as const).map((v) => ({
          value: v,
          label: t(`options.sectionType.${v}`),
        }))}
        onChange={(v) =>
          (v === 'SEATED' || v === 'STANDING') && setValues((s) => ({ ...s, type: v }))
        }
        hint={t(`hints.sectionType.${values.type}`)}
      />
      <TextField
        label={t('fields.name')}
        value={values.name}
        maxLength={120}
        onChange={(name) =>
          setValues((s) => ({ ...s, name, ticketLabel: labelTouched ? s.ticketLabel : name }))
        }
      />
      {nameTaken && <p className="text-xs text-destructive">{t('dialogs.section.nameTaken')}</p>}
      <TextField
        label={t('fields.ticketLabel')}
        hint={t('hints.ticketLabel')}
        value={values.ticketLabel}
        maxLength={120}
        onChange={(ticketLabel) => {
          setLabelTouched(true);
          setValues((s) => ({ ...s, ticketLabel }));
        }}
      />
      {values.type === 'STANDING' && (
        <NumberField
          label={t('fields.capacity')}
          value={values.capacity}
          integer
          min={0}
          max={1_000_000}
          onChange={(v) => v !== null && setValues((s) => ({ ...s, capacity: v }))}
        />
      )}
      <ColorField
        label={t('fields.color')}
        value={values.color}
        allowEmpty
        emptyLabel={t('options.automatic')}
        onChange={(color) => setValues((s) => ({ ...s, color }))}
      />
    </FormDialog>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────────

export type RowValues = Omit<RowSpec, 'curve'>;

export function RowDialog({
  doc,
  curve,
  defaultSectionId,
  onCancel,
  onConfirm,
}: {
  doc: Doc;
  curve: RowGeometry['curve'];
  defaultSectionId: string;
  onCancel: () => void;
  onConfirm: (values: RowValues) => void;
}) {
  const t = useTranslations('editor');
  const radius = doc.settings.seatRadius;
  const nextLabel = (sectionId: string) => {
    const labels = doc.rows.filter((r) => r.sectionId === sectionId).map((r) => r.label);
    if (labels.length === 0) return 'A';
    const last = labels[labels.length - 1]!;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = rowLabelsFor({ label: last, rows: i + 1 })[i]!;
      if (!labels.includes(candidate)) return candidate;
    }
    return `${last}*`;
  };
  const [values, setValues] = useState<RowValues>(() => ({
    sectionId: defaultSectionId,
    label: nextLabel(defaultSectionId),
    mode: 'count',
    count: Math.max(1, seatCountForSpacing(curve, radius * 2.6)),
    spacing: Math.round(radius * 2.6 * 10) / 10,
    numbering: 'ASCENDING',
    labelPlacement: 'BOTH',
    startNumber: 1,
    rows: 1,
    rowOffset: Math.round(radius * 3.2),
  }));
  const set = (patch: Partial<RowValues>) => setValues((v) => ({ ...v, ...patch }));
  const existing = new Set(
    doc.rows.filter((r) => r.sectionId === values.sectionId).map((r) => r.label),
  );
  const labels = rowLabelsFor(values);
  const conflicts = labels.filter((l) => existing.has(l));
  const seatsPerRow = seatCountFor({ ...values, curve });
  const valid = values.label.trim() !== '' && conflicts.length === 0 && values.rows >= 1;
  return (
    <FormDialog
      open
      title={t('dialogs.row.title')}
      description={t('dialogs.row.preview', {
        rows: values.rows,
        seats: seatsPerRow,
        total: seatsPerRow * values.rows,
      })}
      submitLabel={t('dialogs.create')}
      disabled={!valid}
      onCancel={onCancel}
      onSubmit={() => onConfirm({ ...values, label: values.label.trim() })}
    >
      <SelectField
        label={t('fields.section')}
        value={values.sectionId}
        options={seatedOptions(doc)}
        onChange={(v) => v && set({ sectionId: v, label: nextLabel(v) })}
      />
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label={t('fields.rowLabel')}
          value={values.label}
          maxLength={32}
          onChange={(label) => set({ label })}
        />
        <NumberField
          label={t('dialogs.row.rows')}
          value={values.rows}
          integer
          min={1}
          max={100}
          onChange={(v) => v !== null && set({ rows: v })}
        />
      </div>
      {values.rows > 1 && (
        <NumberField
          label={t('dialogs.row.rowOffset')}
          hint={t('dialogs.row.labels', {
            labels: labels.slice(0, 6).join(', ') + (labels.length > 6 ? ' …' : ''),
          })}
          value={values.rowOffset}
          min={1}
          max={10_000}
          onChange={(v) => v !== null && set({ rowOffset: v })}
        />
      )}
      {conflicts.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            {t('dialogs.row.labelsConflict', { labels: conflicts.join(', ') })}
          </AlertDescription>
        </Alert>
      )}
      <SwitchField
        label={t('dialogs.row.bySpacing')}
        checked={values.mode === 'spacing'}
        onChange={(v) => set({ mode: v ? 'spacing' : 'count' })}
      />
      {values.mode === 'count' ? (
        <NumberField
          label={t('fields.seatCount')}
          value={values.count}
          integer
          min={1}
          max={500}
          onChange={(v) => v !== null && set({ count: v })}
        />
      ) : (
        <NumberField
          label={t('dialogs.row.spacing')}
          value={values.spacing}
          min={1}
          max={10_000}
          onChange={(v) => v !== null && set({ spacing: v })}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label={t('fields.numbering')}
          value={values.numbering}
          options={(['ASCENDING', 'DESCENDING', 'ODD_EVEN_FROM_CENTER'] as const).map((v) => ({
            value: v,
            label: t(`options.numbering.${v}`),
          }))}
          onChange={(v) => v && set({ numbering: v as RowValues['numbering'] })}
        />
        <NumberField
          label={t('fields.startNumber')}
          value={values.startNumber}
          integer
          min={0}
          max={100_000}
          onChange={(v) => v !== null && set({ startNumber: v })}
        />
      </div>
      <SelectField
        label={t('fields.labelPlacement')}
        value={values.labelPlacement}
        options={(['START', 'END', 'BOTH', 'NONE'] as const).map((v) => ({
          value: v,
          label: t(`options.labelPlacement.${v}`),
        }))}
        onChange={(v) => v && set({ labelPlacement: v as RowValues['labelPlacement'] })}
      />
    </FormDialog>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────────

export type TableValues = Omit<TableSpec, 'center'>;

export function TableDialog({
  doc,
  defaultSectionId,
  onCancel,
  onConfirm,
}: {
  doc: Doc;
  defaultSectionId: string;
  onCancel: () => void;
  onConfirm: (values: TableValues) => void;
}) {
  const t = useTranslations('editor');
  const tables = doc.elements.filter((e) => e.type === 'TABLE').length;
  const [values, setValues] = useState<TableValues>({
    sectionId: defaultSectionId,
    label: t('defaults.tableLabel', { n: tables + 1 }),
    seatCount: 8,
    tableRadius: Math.round(doc.settings.seatRadius * 3),
    startNumber: 1,
  });
  const set = (patch: Partial<TableValues>) => setValues((v) => ({ ...v, ...patch }));
  return (
    <FormDialog
      open
      title={t('dialogs.table.title')}
      submitLabel={t('dialogs.create')}
      onCancel={onCancel}
      onSubmit={() => onConfirm(values)}
    >
      <SelectField
        label={t('fields.section')}
        value={values.sectionId}
        options={seatedOptions(doc)}
        onChange={(v) => v && set({ sectionId: v })}
      />
      <TextField
        label={t('fields.label')}
        value={values.label}
        maxLength={200}
        onChange={(label) => set({ label })}
      />
      <div className="grid grid-cols-3 gap-2">
        <NumberField
          label={t('fields.seatCount')}
          value={values.seatCount}
          integer
          min={1}
          max={60}
          onChange={(v) => v !== null && set({ seatCount: v })}
        />
        <NumberField
          label={t('dialogs.table.radius')}
          value={values.tableRadius}
          min={1}
          max={10_000}
          onChange={(v) => v !== null && set({ tableRadius: v })}
        />
        <NumberField
          label={t('fields.startNumber')}
          value={values.startNumber}
          integer
          min={0}
          max={100_000}
          onChange={(v) => v !== null && set({ startNumber: v })}
        />
      </div>
    </FormDialog>
  );
}

// ─── Labels (text / exit / facility / stage) ────────────────────────────────

export interface LabelValues {
  label: string;
  icon: string;
  fontSize: number;
}

export function LabelDialog({
  variant,
  onCancel,
  onConfirm,
}: {
  variant: 'TEXT' | 'EXIT' | 'FACILITY' | 'STAGE';
  onCancel: () => void;
  onConfirm: (values: LabelValues) => void;
}) {
  const t = useTranslations('editor');
  const [values, setValues] = useState<LabelValues>({
    label:
      variant === 'EXIT'
        ? t('defaults.exitLabel')
        : variant === 'STAGE'
          ? t('defaults.stageLabel')
          : '',
    icon: '',
    fontSize: variant === 'STAGE' ? 22 : 16,
  });
  const valid = variant !== 'TEXT' || values.label.trim() !== '';
  return (
    <FormDialog
      open
      title={t(`dialogs.label.${variant}`)}
      submitLabel={t('dialogs.create')}
      disabled={!valid}
      onCancel={onCancel}
      onSubmit={() => onConfirm({ ...values, label: values.label.trim() })}
    >
      <TextField
        label={t('fields.label')}
        value={values.label}
        maxLength={200}
        onChange={(label) => setValues((v) => ({ ...v, label }))}
      />
      {variant === 'FACILITY' && (
        <TextField
          label={t('fields.icon')}
          hint={t('hints.icon')}
          value={values.icon}
          maxLength={64}
          onChange={(icon) => setValues((v) => ({ ...v, icon }))}
        />
      )}
      {(variant === 'TEXT' || variant === 'STAGE') && (
        <NumberField
          label={t('fields.fontSize')}
          value={values.fontSize}
          min={1}
          max={500}
          onChange={(fontSize) => fontSize !== null && setValues((v) => ({ ...v, fontSize }))}
        />
      )}
    </FormDialog>
  );
}

// ─── Entrance ───────────────────────────────────────────────────────────────

export function EntranceDialog({
  doc,
  onCancel,
  onConfirm,
}: {
  doc: Doc;
  onCancel: () => void;
  onConfirm: (values: { name: string; code: string }) => void;
}) {
  const t = useTranslations('editor');
  const used = new Set(doc.entrances.map((e) => e.code.toUpperCase()));
  const initialCode =
    Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).find((c) => !used.has(c)) ??
    String(doc.entrances.length + 1);
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(t('defaults.entranceName', { code: initialCode }));
  const taken = used.has(code.trim().toUpperCase());
  const valid = name.trim() !== '' && code.trim() !== '' && !taken;
  return (
    <FormDialog
      open
      title={t('dialogs.entrance.title')}
      submitLabel={t('dialogs.create')}
      disabled={!valid}
      onCancel={onCancel}
      onSubmit={() => onConfirm({ name: name.trim(), code: code.trim() })}
    >
      <TextField label={t('fields.name')} value={name} maxLength={120} onChange={setName} />
      <TextField
        label={t('fields.code')}
        hint={t('hints.entranceCode')}
        value={code}
        maxLength={16}
        onChange={setCode}
      />
      {taken && <p className="text-xs text-destructive">{t('dialogs.entrance.codeTaken')}</p>}
    </FormDialog>
  );
}

// ─── Split row ──────────────────────────────────────────────────────────────

export interface SplitValues {
  /** Number of seats that stay in the original row. */
  firstPartSize: number;
  label: string;
  sectionId: string;
}

export function SplitRowDialog({
  doc,
  rowId,
  initialFirstPartSize,
  onCancel,
  onConfirm,
}: {
  doc: Doc;
  rowId: string;
  initialFirstPartSize: number;
  onCancel: () => void;
  onConfirm: (values: SplitValues) => void;
}) {
  const t = useTranslations('editor');
  const row = doc.rows.find((r) => r.id === rowId)!;
  const seats = rowSeatsInOrder(doc, rowId);
  const [values, setValues] = useState<SplitValues>(() => ({
    firstPartSize: Math.min(Math.max(1, initialFirstPartSize), seats.length - 1),
    label: uniqueRowLabel(doc, row.sectionId, row.label),
    sectionId: row.sectionId,
  }));
  const set = (patch: Partial<SplitValues>) => setValues((v) => ({ ...v, ...patch }));
  const label = values.label.trim();
  const taken = doc.rows.some((r) => r.sectionId === values.sectionId && r.label === label);
  const valid = label !== '' && !taken && seats.length >= 2;
  return (
    <FormDialog
      open
      title={t('dialogs.split.title', { row: row.label })}
      description={t('dialogs.split.description', {
        first: values.firstPartSize,
        second: seats.length - values.firstPartSize,
      })}
      submitLabel={t('dialogs.split.submit')}
      disabled={!valid}
      onCancel={onCancel}
      onSubmit={() => onConfirm({ ...values, label })}
    >
      <SelectField
        label={t('dialogs.split.after')}
        value={String(values.firstPartSize)}
        options={seats.slice(0, -1).map((s, i) => ({
          value: String(i + 1),
          label: t('dialogs.split.afterSeat', { seat: s.label, next: seats[i + 1]!.label }),
        }))}
        onChange={(v) => v && set({ firstPartSize: Number(v) })}
      />
      <SelectField
        label={t('dialogs.split.target')}
        value={values.sectionId}
        options={seatedOptions(doc)}
        onChange={(v) =>
          v &&
          set({ sectionId: v, label: uniqueRowLabel(doc, v, values.label.trim() || row.label) })
        }
      />
      <TextField
        label={t('dialogs.split.label')}
        value={values.label}
        maxLength={32}
        onChange={(v) => set({ label: v })}
      />
      {taken && <p className="text-xs text-destructive">{t('dialogs.split.labelTaken')}</p>}
    </FormDialog>
  );
}

// ─── Validation issues ──────────────────────────────────────────────────────

export interface IssueItem {
  path: (string | number)[];
  message: string;
}

export function IssuesDialog({
  issues,
  onClose,
  onFocus,
}: {
  issues: IssueItem[];
  onClose: () => void;
  onFocus: (issue: IssueItem) => void;
}) {
  const t = useTranslations('editor');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dialogs.issues.title')}</DialogTitle>
          <DialogDescription>{t('dialogs.issues.description')}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
          {issues.slice(0, 100).map((issue, i) => (
            <li key={i}>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left hover:bg-accent"
                onClick={() => onFocus(issue)}
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {issue.path.join('.') || '—'}
                </span>
                <span className="ml-2">{issue.message}</span>
              </button>
            </li>
          ))}
        </ul>
        {issues.length > 100 && (
          <p className="text-xs text-muted-foreground">
            {t('dialogs.issues.more', { count: issues.length - 100 })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
