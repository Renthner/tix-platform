'use client';

import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { ActionForm, ActionFeedback, Field, SubmitButton, errorOf } from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

/**
 * Permanent deletion of an archived event. Requires typing the exact event title.
 * Disabled (with explanation) unless the event is archived and has no orders.
 */
export function EventDangerZone({
  action,
  title,
  archived,
  hasOrders,
}: {
  action: Action;
  title: string;
  archived: boolean;
  hasOrders: boolean;
}) {
  const t = useTranslations('admin.events.danger');
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [state, formAction] = useActionState(action, IDLE);
  const enabled = archived && !hasOrders;

  return (
    <div className="space-y-3 rounded-xl border border-destructive/40 p-5">
      <div>
        <h2 className="font-semibold text-destructive">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {!archived && (
        <Alert>
          <AlertDescription>{t('notArchived')}</AlertDescription>
        </Alert>
      )}
      {archived && hasOrders && (
        <Alert variant="destructive">
          <AlertDescription>{t('hasOrders')}</AlertDescription>
        </Alert>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setTyped('');
        }}
      >
        <DialogTrigger asChild>
          <Button type="button" variant="destructive" disabled={!enabled}>
            <Trash2 /> {t('button')}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>{t('confirmDescription')}</DialogDescription>
          </DialogHeader>
          <ActionForm action={formAction} className="space-y-4">
            <ActionFeedback state={state} />
            <Field
              label={t('typeTitle', { title })}
              htmlFor="confirmTitle"
              error={errorOf(state, 'confirmTitle')}
            >
              <Input
                id="confirmTitle"
                name="confirmTitle"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {tc('cancel')}
              </Button>
              <SubmitButton variant="destructive" disabled={typed.trim() !== title.trim()}>
                {t('confirm')}
              </SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </div>
  );
}
