'use client';

import type { EventSeatingMode } from '@tix/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ConfirmAction } from './confirm-action';
import { ConfirmDialog } from './confirm-dialog';
import { EmptyState } from './empty-state';
import {
  ActionFeedback,
  ActionForm,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

// ─── Venue & seating ────────────────────────────────────────────────────────

/**
 * Current seating mode, venue and plan of the event. While the event is a DRAFT without orders
 * the "Change" dialog swaps mode / venue / plan (after a confirmation: the current event plan
 * copy is deleted); otherwise the button is disabled and the reason shown.
 */
export function EventSeatingCardBody({
  action,
  mode,
  venueId,
  venueName,
  planName,
  venues,
  templates,
  blocked,
}: {
  action: Action;
  mode: EventSeatingMode;
  venueId: string | null;
  venueName: string | null;
  planName: string | null;
  venues: { id: string; name: string }[];
  templates: { id: string; name: string; venueId: string | null }[];
  /** Why a change is impossible right now (null = allowed). */
  blocked: 'notDraft' | 'inUse' | null;
}) {
  const t = useTranslations('admin.seating.mode');
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);
  const [nextMode, setNextMode] = useState<EventSeatingMode>(mode);
  const [nextVenue, setNextVenue] = useState(venueId ?? venues[0]?.id ?? '');
  const [nextTemplate, setNextTemplate] = useState('');
  const formId = useId();
  const venueTemplates = useMemo(
    () => templates.filter((tpl) => tpl.venueId === nextVenue),
    [templates, nextVenue],
  );
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  const err = (name: string) => errorOf(state, name);
  const seated = nextMode === 'SEATED';

  return (
    <div className="space-y-4">
      <dl className="grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('mode')}</dt>
          <dd className="font-medium">{mode === 'SEATED' ? t('seated') : t('admission')}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('venue')}</dt>
          <dd>{venueName ?? t('noVenue')}</dd>
        </div>
        {mode === 'SEATED' && (
          <div>
            <dt className="text-xs text-muted-foreground">{t('plan')}</dt>
            <dd>{planName ?? '—'}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={blocked !== null}
          onClick={() => setOpen(true)}
        >
          <Pencil /> {t('change')}
        </Button>
        {blocked && (
          <p className="text-sm text-muted-foreground">
            {blocked === 'notDraft' ? t('blockedNotDraft') : t('blockedInUse')}
          </p>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>
          <ActionForm id={formId} action={formAction} className="space-y-4">
            <ActionFeedback state={state} />
            <Field label={t('mode')} htmlFor={`${formId}-mode`} error={err('seatingMode')}>
              <NativeSelect
                id={`${formId}-mode`}
                name="seatingMode"
                value={nextMode}
                onChange={(e) => {
                  const next = e.target.value as EventSeatingMode;
                  setNextMode(next);
                  if (next === 'SEATED' && !nextVenue) setNextVenue(venues[0]?.id ?? '');
                }}
              >
                <option value="SEATED" disabled={venues.length === 0}>
                  {t('seated')}
                </option>
                <option value="ADMISSION">{t('admission')}</option>
              </NativeSelect>
            </Field>
            <Field label={t('venue')} htmlFor={`${formId}-venue`} error={err('venueId')}>
              <NativeSelect
                id={`${formId}-venue`}
                name="venueId"
                value={nextVenue}
                required={seated}
                onChange={(e) => {
                  setNextVenue(e.target.value);
                  setNextTemplate('');
                }}
              >
                {!seated && <option value="">{t('noVenue')}</option>}
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {seated && (
              <Field label={t('plan')} htmlFor={`${formId}-template`} error={err('templateId')}>
                <NativeSelect
                  id={`${formId}-template`}
                  name="templateId"
                  value={nextTemplate}
                  onChange={(e) => setNextTemplate(e.target.value)}
                >
                  <option value="">{t('emptyPlan')}</option>
                  {venueTemplates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button type="button" onClick={() => setConfirm(true)}>
                {t('apply')}
              </Button>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('confirmTitle')}
        description={t('confirmDescription')}
        confirmLabel={t('confirm')}
        onConfirm={() => {
          setConfirm(false);
          (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit();
        }}
      />
    </div>
  );
}

// ─── Contingents ────────────────────────────────────────────────────────────

export interface ContingentRow {
  id: string;
  name: string;
  capacity: number;
  allocated: number;
  held: number;
  priceCategoryId: string | null;
  entranceId: string | null;
}

interface Option {
  id: string;
  name: string;
}

/** Contingents (quantity-based admission) of an admission-only event: list, add, edit, remove. */
export function ContingentsManager({
  saveAction,
  removeActions,
  contingents,
  categories,
  entrances,
}: {
  saveAction: Action;
  /** Bound remove action per contingent id. */
  removeActions: Record<string, Action>;
  contingents: ContingentRow[];
  categories: (Option & { color: string })[];
  entrances: Option[];
}) {
  const t = useTranslations('admin.seating.contingents');
  const [editing, setEditing] = useState<ContingentRow | 'new' | null>(null);
  const byCategory = new Map(categories.map((c) => [c.id, c]));
  const byEntrance = new Map(entrances.map((e) => [e.id, e]));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setEditing('new')} disabled={categories.length === 0}>
          <Plus /> {t('add')}
        </Button>
      </div>
      {categories.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('noCategories')}</p>
      )}
      {contingents.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('category')}</TableHead>
              {entrances.length > 0 && <TableHead>{t('entrance')}</TableHead>}
              <TableHead className="text-right">{t('capacity')}</TableHead>
              <TableHead className="text-right">{t('soldHeld')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {contingents.map((c) => {
              const category = c.priceCategoryId ? byCategory.get(c.priceCategoryId) : undefined;
              const inUse = c.allocated > 0 || c.held > 0;
              return (
                <TableRow key={c.id} data-testid="contingent-row">
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {category && (
                        <span
                          className="size-3 rounded-full border"
                          style={{ backgroundColor: category.color }}
                          aria-hidden
                        />
                      )}
                      {category?.name ?? t('noCategory')}
                    </span>
                  </TableCell>
                  {entrances.length > 0 && (
                    <TableCell>
                      {(c.entranceId && byEntrance.get(c.entranceId)?.name) ?? '—'}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">{c.capacity}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.allocated} / {c.held}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={t('editLabel', { name: c.name })}
                        title={t('editLabel', { name: c.name })}
                        onClick={() => setEditing(c)}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      {removeActions[c.id] && (
                        <ConfirmAction
                          action={removeActions[c.id]!}
                          title={t('removeTitle', { name: c.name })}
                          description={inUse ? t('removeInUse') : t('removeDescription')}
                          confirmLabel={t('remove')}
                          label={t('removeLabel', { name: c.name })}
                          disabled={inUse}
                          variant="ghost"
                          size="icon"
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </ConfirmAction>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {editing !== null && (
        <ContingentDialog
          key={editing === 'new' ? 'new' : editing.id}
          action={saveAction}
          initial={editing === 'new' ? null : editing}
          categories={categories}
          entrances={entrances}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ContingentDialog({
  action,
  initial,
  categories,
  entrances,
  onClose,
}: {
  action: Action;
  initial: ContingentRow | null;
  categories: Option[];
  entrances: Option[];
  onClose: () => void;
}) {
  const t = useTranslations('admin.seating.contingents');
  const [state, formAction] = useActionState(action, IDLE);
  const id = useId();
  useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state, onClose]);
  const err = (name: string) => errorOf(state, name);
  const minimum = initial ? initial.allocated + initial.held : 0;
  // Sold / held spots keep their price category (the server refuses a change as well).
  const categoryLocked = minimum > 0 && !!initial?.priceCategoryId;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? t('editTitle') : t('addTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          {initial && <input type="hidden" name="id" value={initial.id} />}
          <Field label={t('name')} htmlFor={`${id}-name`} error={err('name')}>
            <Input
              id={`${id}-name`}
              name="name"
              required
              maxLength={120}
              defaultValue={initial?.name ?? ''}
            />
          </Field>
          <Field
            label={t('category')}
            htmlFor={`${id}-category`}
            error={err('priceCategoryId')}
            hint={categoryLocked ? t('categoryLocked') : undefined}
          >
            {/* A disabled select is not submitted: send the current category explicitly. */}
            {categoryLocked && (
              <input type="hidden" name="priceCategoryId" value={initial!.priceCategoryId!} />
            )}
            <NativeSelect
              id={`${id}-category`}
              name={categoryLocked ? undefined : 'priceCategoryId'}
              required={!categoryLocked}
              disabled={categoryLocked}
              defaultValue={initial?.priceCategoryId ?? categories[0]?.id ?? ''}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            label={t('capacity')}
            htmlFor={`${id}-capacity`}
            error={err('capacity')}
            hint={minimum > 0 ? t('capacityMinimum', { minimum }) : undefined}
          >
            <Input
              id={`${id}-capacity`}
              name="capacity"
              type="number"
              inputMode="numeric"
              min={minimum}
              max={1_000_000}
              step={1}
              required
              defaultValue={initial?.capacity ?? ''}
            />
          </Field>
          {entrances.length > 0 && (
            <Field label={t('entrance')} htmlFor={`${id}-entrance`} error={err('entranceId')}>
              <NativeSelect
                id={`${id}-entrance`}
                name="entranceId"
                defaultValue={initial?.entranceId ?? ''}
              >
                <option value="">{t('noEntrance')}</option>
                {entrances.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <SubmitButton>{initial ? t('save') : t('add')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
