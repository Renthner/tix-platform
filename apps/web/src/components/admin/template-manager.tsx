'use client';

import { Copy, Download, LayoutTemplate, Pencil, PencilRuler, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { IDLE, type ActionState } from '@/lib/action-state';
import { EmptyState } from './empty-state';
import { ActionForm, ActionFeedback, Field, SubmitButton, errorOf } from './form-controls';
import { RowActions } from './row-actions';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export interface TemplateRow {
  id: string;
  name: string;
  seats: number;
  updatedAt: string;
  rename: Action;
  duplicate: Action;
  remove: Action;
}

export function TemplateManager({
  templates,
  create,
}: {
  templates: TemplateRow[];
  create: Action;
}) {
  const t = useTranslations('admin.venues.plans');
  const format = useFormatter();
  return (
    <div className="space-y-4">
      {templates.length === 0 ? (
        <EmptyState size="sm" icon={LayoutTemplate} title={t('empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead className="text-right">{t('seats')}</TableHead>
              <TableHead>{t('updated')}</TableHead>
              <TableHead className="text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((tpl) => (
              <TableRow key={tpl.id}>
                <TableCell className="font-medium">{tpl.name}</TableCell>
                <TableCell className="text-right tabular-nums">{tpl.seats}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {format.dateTime(new Date(tpl.updatedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button asChild size="sm">
                      <Link href={`/admin/seat-maps/${tpl.id}`}>
                        <PencilRuler /> {t('openEditor')}
                      </Link>
                    </Button>
                    <TemplateRowMenu template={tpl} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CreateTemplateForm action={create} />
    </div>
  );
}

type RowDialog = 'rename' | 'duplicate' | 'delete';

/**
 * "⋯" menu of a master plan: rename, export, duplicate, delete. The dialogs live outside the menu
 * (controlled), so they stay mounted when the menu closes.
 */
function TemplateRowMenu({ template }: { template: TemplateRow }) {
  const t = useTranslations('admin.venues.plans');
  const tl = useTranslations('admin.list');
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  // Set when the menu closes because a dialog opens: the focus then goes to the dialog.
  const openingDialog = useRef(false);
  const show = (next: RowDialog) => {
    openingDialog.current = true;
    setDialog(next);
  };
  const toggle = (which: RowDialog) => (open: boolean) => setDialog(open ? which : null);
  return (
    <>
      <RowActions
        label={tl('rowActions', { name: template.name })}
        data-testid="seat-plan-row-actions"
        onCloseAutoFocus={(e) => {
          if (openingDialog.current) e.preventDefault();
          openingDialog.current = false;
        }}
      >
        <DropdownMenuItem onSelect={() => show('rename')}>
          <Pencil /> {t('rename')}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`/api/admin/seat-maps/${template.id}/export`} download>
            <Download /> {t('export')}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => show('duplicate')}>
          <Copy /> {t('duplicate')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => show('delete')}>
          <Trash2 /> {t('delete')}
        </DropdownMenuItem>
      </RowActions>
      <RenameDialog
        name={template.name}
        action={template.rename}
        open={dialog === 'rename'}
        onOpenChange={toggle('rename')}
      />
      <ConfirmActionDialog
        action={template.duplicate}
        open={dialog === 'duplicate'}
        onOpenChange={toggle('duplicate')}
        variant="secondary"
        title={t('duplicateTitle')}
        description={t('duplicateDescription', { name: template.name })}
        confirmLabel={t('duplicate')}
      />
      <ConfirmActionDialog
        action={template.remove}
        open={dialog === 'delete'}
        onOpenChange={toggle('delete')}
        variant="destructive"
        title={t('deleteTitle')}
        description={t('deleteDescription', { name: template.name })}
        confirmLabel={t('delete')}
      />
    </>
  );
}

/** Runs a bound server action from a controlled dialog; a successful result closes it. */
function useDialogAction(action: Action, onOpenChange: (open: boolean) => void) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const close = useRef(onOpenChange);
  useEffect(() => {
    close.current = onOpenChange;
  });
  useEffect(() => {
    if (state.status === 'success') close.current(false);
  }, [state]);
  /** Dialog `onOpenChange` that ignores close requests while the action is pending. */
  const setOpen = (next: boolean) => {
    if (!next && pending) return;
    onOpenChange(next);
  };
  return [state, formAction, pending, setOpen] as const;
}

/** Controlled confirmation dialog for a bound server action (the menu-friendly `ConfirmAction`). */
function ConfirmActionDialog({
  action,
  open,
  onOpenChange,
  variant,
  title,
  description,
  confirmLabel,
}: {
  action: Action;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: 'secondary' | 'destructive';
  title: string;
  description: string;
  confirmLabel: string;
}) {
  const tc = useTranslations('common.actions');
  const [state, formAction, pending, setOpen] = useDialogAction(action, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={!pending}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              {tc('cancel')}
            </Button>
            <SubmitButton variant={variant}>{confirmLabel}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  name,
  action,
  open,
  onOpenChange,
}: {
  name: string;
  action: Action;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('admin.venues.plans');
  const tc = useTranslations('common.actions');
  const [state, formAction, pending, setOpen] = useDialogAction(action, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={!pending}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('rename')}</DialogTitle>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <Field label={t('name')} htmlFor="rename-name" error={errorOf(state, 'name')}>
            <Input id="rename-name" name="name" defaultValue={name} required maxLength={120} />
          </Field>
          <DialogFooter>
            <SubmitButton>{tc('save')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function CreateTemplateForm({ action }: { action: Action }) {
  const t = useTranslations('admin.venues.plans');
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <ActionForm
      action={formAction}
      resetOnSuccess={state}
      className="space-y-3 rounded-lg border p-4"
    >
      <h3 className="text-sm font-medium">{t('new')}</h3>
      <ActionFeedback state={state} />
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end">
        <Field label={t('name')} htmlFor="tpl-name" error={errorOf(state, 'name')}>
          <Input id="tpl-name" name="name" required maxLength={120} />
        </Field>
        <Field label={t('width')} htmlFor="tpl-w" error={errorOf(state, 'canvasWidth')}>
          <Input
            id="tpl-w"
            name="canvasWidth"
            type="number"
            min={100}
            max={100000}
            defaultValue={2000}
            required
          />
        </Field>
        <Field label={t('height')} htmlFor="tpl-h" error={errorOf(state, 'canvasHeight')}>
          <Input
            id="tpl-h"
            name="canvasHeight"
            type="number"
            min={100}
            max={100000}
            defaultValue={1400}
            required
          />
        </Field>
        <SubmitButton>{t('create')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
