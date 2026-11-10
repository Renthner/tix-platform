'use client';

import { Copy, Download, PencilRuler, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Link } from '@/i18n/navigation';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ConfirmAction } from './confirm-action';
import { ActionForm, ActionFeedback, Field, SubmitButton, errorOf } from './form-controls';

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
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
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
                <TableCell className="text-muted-foreground">
                  {format.dateTime(new Date(tpl.updatedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button asChild size="sm">
                      <Link href={`/admin/seat-maps/${tpl.id}`}>
                        <PencilRuler /> {t('openEditor')}
                      </Link>
                    </Button>
                    <RenameDialog name={tpl.name} action={tpl.rename} />
                    <Button asChild size="sm" variant="outline">
                      <a href={`/api/admin/seat-maps/${tpl.id}/export`} download>
                        <Download /> {t('export')}
                      </a>
                    </Button>
                    <ConfirmAction
                      action={tpl.duplicate}
                      variant="secondary"
                      title={t('duplicateTitle')}
                      description={t('duplicateDescription', { name: tpl.name })}
                      confirmLabel={t('duplicate')}
                    >
                      <Copy /> {t('duplicate')}
                    </ConfirmAction>
                    <ConfirmAction
                      action={tpl.remove}
                      title={t('deleteTitle')}
                      description={t('deleteDescription', { name: tpl.name })}
                      confirmLabel={t('delete')}
                    >
                      <Trash2 /> {t('delete')}
                    </ConfirmAction>
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

function RenameDialog({ name, action }: { name: string; action: Action }) {
  const t = useTranslations('admin.venues.plans');
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          {t('rename')}
        </Button>
      </DialogTrigger>
      <DialogContent>
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
