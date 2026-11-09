'use client';

import {
  INFO_BOX_SIZES,
  MAX_EVENT_INFO_BOXES,
  MAX_ITEMS_PER_ROW,
  boxRef,
  type InfoBoxSize,
  type PageBlockRef,
  type PageLayout,
  type PageLayoutItem,
} from '@tix/shared';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  FileText,
  GripVertical,
  ImageIcon,
  Info,
  Lock,
  Plus,
  Rows3,
  Ticket,
  Trash2,
  UnfoldHorizontal,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState, type DragEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SymbolPicker } from '@/components/seatmap-editor/symbol-picker';
import type { EditorSymbol } from '@/components/seatmap-editor/types';
import { IDLE, type ActionState } from '@/lib/action-state';
import { cn } from '@/lib/utils';
import { ActionForm, ActionFeedback, NativeSelect, SubmitButton } from './form-controls';
import { RichTextEditor } from './rich-text-editor';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export interface InfoBoxValue {
  id: string;
  title: string;
  symbolId: string | null;
  content: string;
  textSize: InfoBoxSize;
  iconSize: InfoBoxSize;
}

type DropTarget =
  | { kind: 'join'; row: number; col: number; side: 'before' | 'after' }
  | { kind: 'row'; index: number };

// ─── Layout operations (pure) ───────────────────────────────────────────────

type Slots = (PageLayoutItem | null)[][];
const clean = (rows: Slots): PageLayout =>
  rows.map((r) => r.filter((i): i is PageLayoutItem => i !== null)).filter((r) => r.length > 0);
const withoutRef = (layout: PageLayout, ref: PageBlockRef): Slots =>
  layout.map((row) => row.map((item) => (item.ref === ref ? null : item)));
const findItem = (layout: PageLayout, ref: PageBlockRef) =>
  layout.flat().find((item) => item.ref === ref);

/** Can `ref` be placed into row `row` next to the items there? */
function canJoin(layout: PageLayout, ref: PageBlockRef, row: number): boolean {
  const target = layout[row];
  if (!target || ref === 'SHOP' || target.some((i) => i.ref === 'SHOP')) return false;
  return target.filter((i) => i.ref !== ref).length < MAX_ITEMS_PER_ROW;
}

function applyDrop(layout: PageLayout, ref: PageBlockRef, target: DropTarget): PageLayout {
  const item = findItem(layout, ref);
  if (!item) return layout;
  const rows = withoutRef(layout, ref);
  if (target.kind === 'row') rows.splice(target.index, 0, [item]);
  else {
    if (!canJoin(layout, ref, target.row)) return layout;
    rows[target.row]!.splice(target.col + (target.side === 'after' ? 1 : 0), 0, item);
  }
  return clean(rows);
}

/**
 * Event page designer: rows of blocks (description, seating plan, info boxes) arranged by
 * drag & drop – blocks dropped onto another block sit next to it – plus the info boxes with
 * adjustable text and icon size.
 */
export function EventPageEditor({
  action,
  initialLayout,
  initialBoxes,
  symbols,
  templateSymbols,
}: {
  action: Action;
  initialLayout: PageLayout;
  initialBoxes: InfoBoxValue[];
  symbols: EditorSymbol[];
  templateSymbols: { discounts: string | null; accessibility: string | null };
}) {
  const t = useTranslations('admin.events.page');
  const tc = useTranslations('common.actions');
  const [state, formAction] = useActionState(action, IDLE);
  const [layout, setLayout] = useState<PageLayout>(initialLayout);
  const [boxes, setBoxes] = useState<InfoBoxValue[]>(initialBoxes);
  const [dragging, setDragging] = useState<PageBlockRef | null>(null);
  const [hover, setHover] = useState<DropTarget | null>(null);
  const full = boxes.length >= MAX_EVENT_INFO_BOXES;

  const labelOf = (ref: PageBlockRef) => {
    if (ref === 'COVER') return t('blocks.COVER');
    if (ref === 'DESCRIPTION') return t('blocks.DESCRIPTION');
    if (ref === 'SHOP') return t('blocks.SHOP');
    const index = boxes.findIndex((b) => boxRef(b.id) === ref);
    const box = boxes[index];
    return t('blockBox', { title: box?.title || t('boxNumber', { n: index + 1 }) });
  };
  const iconOf = (ref: PageBlockRef) =>
    ref === 'COVER' ? ImageIcon : ref === 'DESCRIPTION' ? FileText : ref === 'SHOP' ? Ticket : Info;

  const endDrag = () => {
    setDragging(null);
    setHover(null);
  };
  const drop = (e: DragEvent, target: DropTarget | null) => {
    e.preventDefault();
    if (dragging && target) setLayout((l) => applyDrop(l, dragging, target));
    endDrag();
  };
  const move = (ref: PageBlockRef, target: DropTarget) =>
    setLayout((l) => applyDrop(l, ref, target));

  const addBox = (box?: Partial<InfoBoxValue>) => {
    const id = crypto.randomUUID();
    setBoxes((all) => [
      ...all,
      { id, title: '', symbolId: null, content: '', textSize: 'M', iconSize: 'M', ...box },
    ]);
    setLayout((l) => [...l, [{ ref: boxRef(id), span: 1 }]]);
  };
  const removeBox = (id: string) => {
    setBoxes((all) => all.filter((b) => b.id !== id));
    setLayout((l) => clean(withoutRef(l, boxRef(id))));
  };
  const patchBox = (id: string, patch: Partial<InfoBoxValue>) =>
    setBoxes((all) => all.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const patchItem = (ref: PageBlockRef, patch: Partial<PageLayoutItem>) =>
    setLayout((l) => l.map((row) => row.map((i) => (i.ref === ref ? { ...i, ...patch } : i))));
  const swapRows = (a: number, b: number) =>
    setLayout((l) => {
      const next = [...l];
      [next[a], next[b]] = [next[b]!, next[a]!];
      return next;
    });

  /** Drop zone between rows: dropping there gives the block a row of its own. */
  const rowGap = (index: number) => {
    const active = hover?.kind === 'row' && hover.index === index;
    return (
      <div
        data-row-gap={index}
        onDragOver={(e) => {
          if (!dragging) return;
          e.preventDefault();
          if (!active) setHover({ kind: 'row', index });
        }}
        onDrop={(e) => drop(e, { kind: 'row', index })}
        className={cn(
          'flex items-center justify-center rounded-md text-xs transition-all',
          dragging ? 'h-7' : 'h-2',
          active && 'h-10 border-2 border-dashed border-primary bg-primary/5 text-primary',
        )}
      >
        {active && t('dropNewRow')}
      </div>
    );
  };

  return (
    <ActionForm action={formAction} className="space-y-8">
      <ActionFeedback state={state} />
      <input type="hidden" name="layout" value={JSON.stringify(layout)} />
      <input
        type="hidden"
        name="boxes"
        value={JSON.stringify(
          boxes.map(({ id, title, symbolId, textSize, iconSize }) => ({
            id,
            title,
            symbolId,
            textSize,
            iconSize,
          })),
        )}
      />

      {/* ── Page layout ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t('layoutTitle')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('layoutHint', { max: MAX_ITEMS_PER_ROW })}
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-dashed bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <Lock className="size-4" />
          <span className="flex-1">{t('header')}</span>
          <span className="text-xs">{t('headerFixed')}</span>
        </div>
        <div>
          {rowGap(0)}
          {layout.map((row, r) => (
            <div key={row.map((i) => i.ref).join('|')}>
              <div className="flex items-stretch gap-2" data-layout-row={r}>
                {row.map((item, c) => {
                  const Icon = iconOf(item.ref);
                  const joinHover =
                    hover?.kind === 'join' && hover.row === r && hover.col === c ? hover : null;
                  return (
                    <div
                      key={item.ref}
                      data-layout-item={item.ref}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', item.ref);
                        setDragging(item.ref);
                      }}
                      onDragEnd={endDrag}
                      onDragOver={(e) => {
                        if (!dragging || dragging === item.ref || !canJoin(layout, dragging, r))
                          return;
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                        if (joinHover?.side !== side)
                          setHover({ kind: 'join', row: r, col: c, side });
                      }}
                      onDrop={(e) => drop(e, hover?.kind === 'join' ? hover : null)}
                      style={{ flexGrow: item.span }}
                      className={cn(
                        'min-w-0 basis-0 cursor-grab space-y-2 rounded-lg border bg-card p-3 shadow-xs transition-shadow active:cursor-grabbing',
                        dragging === item.ref && 'opacity-50',
                        joinHover?.side === 'before' && 'shadow-[inset_4px_0_0_var(--primary)]',
                        joinHover?.side === 'after' && 'shadow-[inset_-4px_0_0_var(--primary)]',
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{labelOf(item.ref)}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        {row.length > 1 && (
                          <>
                            <IconButton
                              label={t('moveLeft')}
                              disabled={c === 0}
                              onClick={() =>
                                move(item.ref, { kind: 'join', row: r, col: c - 1, side: 'before' })
                              }
                            >
                              <ArrowLeft />
                            </IconButton>
                            <IconButton
                              label={t('moveRight')}
                              disabled={c === row.length - 1}
                              onClick={() =>
                                move(item.ref, { kind: 'join', row: r, col: c + 1, side: 'after' })
                              }
                            >
                              <ArrowRight />
                            </IconButton>
                            <IconButton
                              label={t('ownRow')}
                              onClick={() => move(item.ref, { kind: 'row', index: r + 1 })}
                            >
                              <Rows3 />
                            </IconButton>
                            <Button
                              type="button"
                              size="sm"
                              variant={item.span === 2 ? 'default' : 'outline'}
                              className="h-7 px-2 text-xs"
                              aria-pressed={item.span === 2}
                              onClick={() => patchItem(item.ref, { span: item.span === 2 ? 1 : 2 })}
                            >
                              <UnfoldHorizontal /> {t('wide')}
                            </Button>
                          </>
                        )}
                        {r > 0 && canJoin(layout, item.ref, r - 1) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              move(item.ref, {
                                kind: 'join',
                                row: r - 1,
                                col: layout[r - 1]!.length - 1,
                                side: 'after',
                              })
                            }
                          >
                            <ArrowUp /> {t('joinAbove')}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-col justify-center gap-1">
                  <IconButton
                    label={t('rowUp')}
                    disabled={r === 0}
                    onClick={() => swapRows(r, r - 1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={t('rowDown')}
                    disabled={r === layout.length - 1}
                    onClick={() => swapRows(r, r + 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                </div>
              </div>
              {rowGap(r + 1)}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('mobileHint')}</p>
      </section>

      {/* ── Info boxes ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t('boxesTitle')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('boxesHint', { max: MAX_EVENT_INFO_BOXES })}
          </p>
        </div>
        {boxes.length === 0 && (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            {t('emptyBoxes')}
          </p>
        )}
        <div className="space-y-3">
          {boxes.map((box, index) => (
            <div key={box.id} className="space-y-3 rounded-lg border bg-card p-4 shadow-xs">
              <div className="flex items-center gap-2">
                <Info className="size-4 text-muted-foreground" />
                <span className="flex-1 text-xs font-medium text-muted-foreground">
                  {t('boxNumber', { n: index + 1 })}
                </span>
                <IconButton label={t('removeBox')} onClick={() => removeBox(box.id)}>
                  <Trash2 />
                </IconButton>
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_220px]">
                <div className="space-y-1.5">
                  <Label htmlFor={`box-title-${box.id}`}>{t('boxTitle')}</Label>
                  <Input
                    id={`box-title-${box.id}`}
                    value={box.title}
                    maxLength={120}
                    onChange={(e) => patchBox(box.id, { title: e.target.value })}
                  />
                </div>
                <SymbolPicker
                  label={t('boxIcon')}
                  symbols={symbols}
                  kind="ELEMENT"
                  value={box.symbolId}
                  previewColor="#334155"
                  noneLabel={t('noIcon')}
                  onChange={(symbolId) => patchBox(box.id, { symbolId })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 md:max-w-md">
                <SizeSelect
                  id={`box-text-${box.id}`}
                  label={t('textSize')}
                  value={box.textSize}
                  onChange={(textSize) => patchBox(box.id, { textSize })}
                />
                <SizeSelect
                  id={`box-icon-${box.id}`}
                  label={t('iconSize')}
                  value={box.iconSize}
                  onChange={(iconSize) => patchBox(box.id, { iconSize })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('boxContent')}</Label>
                <RichTextEditor
                  name={`content:${box.id}`}
                  defaultValue={box.content}
                  ariaLabel={t('boxContent')}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <AddButton disabled={full} onClick={() => addBox()}>
            {t('addBox')}
          </AddButton>
          <AddButton
            disabled={full}
            onClick={() =>
              addBox({
                title: t('templates.discounts.title'),
                symbolId: templateSymbols.discounts,
                content: t.raw('templates.discounts.content') as string,
              })
            }
          >
            {t('addTemplate', { name: t('templates.discounts.title') })}
          </AddButton>
          <AddButton
            disabled={full}
            onClick={() =>
              addBox({
                title: t('templates.accessibility.title'),
                symbolId: templateSymbols.accessibility,
                content: t.raw('templates.accessibility.content') as string,
                textSize: 'L',
                iconSize: 'L',
              })
            }
          >
            {t('addTemplate', { name: t('templates.accessibility.title') })}
          </AddButton>
        </div>
      </section>

      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

function SizeSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: InfoBoxSize;
  onChange: (value: InfoBoxSize) => void;
}) {
  const t = useTranslations('admin.events.page');
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value as InfoBoxSize)}>
        {INFO_BOX_SIZES.map((s) => (
          <option key={s} value={s}>
            {t(`sizes.${s}`)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function AddButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onClick}>
      <Plus /> {children}
    </Button>
  );
}
