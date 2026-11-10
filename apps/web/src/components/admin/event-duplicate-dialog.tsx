'use client';

import { Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ActionFeedback, ActionForm, Field, SubmitButton, errorOf } from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

/** "Duplicate event" dialog: title, start (event time zone) and optional slug. */
export function EventDuplicateDialog({
  action,
  title,
  startsAt,
  size = 'default',
}: {
  action: Action;
  title: string;
  /** Source start as datetime-local value in the event's time zone. */
  startsAt: string;
  size?: 'default' | 'sm';
}) {
  const t = useTranslations('admin.events.duplicate');
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size={size}>
          <Copy /> {t('button')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <Field label={t('fields.title')} htmlFor="dupTitle" error={errorOf(state, 'title')}>
            <Input
              id="dupTitle"
              name="title"
              required
              maxLength={200}
              defaultValue={t('copyTitle', { title })}
            />
          </Field>
          <Field
            label={t('fields.startsAt')}
            htmlFor="dupStartsAt"
            error={errorOf(state, 'startsAt')}
            hint={t('startsAtHint')}
          >
            <Input
              id="dupStartsAt"
              name="startsAt"
              type="datetime-local"
              required
              defaultValue={startsAt}
            />
          </Field>
          <Field
            label={t('fields.slug')}
            htmlFor="dupSlug"
            error={errorOf(state, 'slug')}
            hint={t('slugHint')}
          >
            <Input id="dupSlug" name="slug" maxLength={80} autoComplete="off" />
          </Field>
          <div className="space-y-1 rounded-md bg-muted p-3 text-sm text-muted-foreground">
            <p>{t('copied')}</p>
            <p>{t('notCopied')}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </Button>
            <SubmitButton pendingLabel={t('pending')}>{t('confirm')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
