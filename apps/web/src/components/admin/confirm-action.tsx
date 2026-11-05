'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
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
import { IDLE, type ActionState } from '@/lib/action-state';
import { ActionForm, ActionFeedback, SubmitButton } from './form-controls';

/** Button that opens a confirmation dialog and then runs a (bound) server action. */
export function ConfirmAction({
  action,
  title,
  description,
  confirmLabel,
  variant = 'destructive',
  size = 'sm',
  disabled = false,
  label,
  children,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  disabled?: boolean;
  /** Accessible name / tooltip for icon-only triggers. */
  label?: string;
  children: ReactNode;
}) {
  const t = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={variant === 'destructive' ? 'outline' : variant}
          size={size}
          disabled={disabled}
          aria-label={label}
          title={label}
        >
          {children}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <SubmitButton variant={variant}>{confirmLabel}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
