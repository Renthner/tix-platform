'use client';

import { useTranslations } from 'next-intl';
import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
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
import { IDLE } from '@/lib/action-state';
import type { FeeActionState } from '@/server/admin/fees';
import { ActionForm, SubmitButton } from '../form-controls';
import type { Action } from './types';

// ─── Feedback & dialogs ─────────────────────────────────────────────────────

/** Toasts on success; alert for form-level and fee-specific errors (input stays in place). */
export function FeeFeedback({ state }: { state: FeeActionState }) {
  const t = useTranslations('fees');
  const ta = useTranslations('admin');
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === lastAt.current) return;
    lastAt.current = state.at;
    if (state.status === 'success') {
      toast.success(
        state.feeMessage
          ? t(`messages.${state.feeMessage}`)
          : ta(`messages.${state.message ?? 'saved'}`),
      );
    } else if (!state.formError && !state.feeError) {
      toast.error(ta('errors.form.validation'));
    }
  }, [state, t, ta]);
  if (state.status !== 'error' || (!state.feeError && !state.formError)) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {state.feeError ? t(`errors.${state.feeError}`) : ta(`errors.form.${state.formError!}`)}
      </AlertDescription>
    </Alert>
  );
}

/** Toast for actions called directly (toggle, reorder). */
export function useDirectFeedback() {
  const t = useTranslations('fees');
  const ta = useTranslations('admin');
  return (state: FeeActionState) => {
    if (state.status === 'success') {
      toast.success(
        state.feeMessage
          ? t(`messages.${state.feeMessage}`)
          : ta(`messages.${state.message ?? 'saved'}`),
      );
    } else if (state.status === 'error') {
      toast.error(
        state.feeError
          ? t(`errors.${state.feeError}`)
          : ta(`errors.form.${state.formError ?? 'generic'}`),
      );
    }
  };
}

export function useDialogAction(action: Action) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<FeeActionState, FormData>(action, IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  return { open, setOpen, state, formAction };
}

export function TriggerButton({
  icon,
  label,
  primary,
  ...props
}: ComponentProps<typeof Button> & { icon: ReactNode; label: string; primary?: boolean }) {
  return primary ? (
    <Button type="button" size="sm" {...props}>
      {icon} {label}
    </Button>
  ) : (
    <Button
      type="button"
      size="icon-sm"
      variant="outline"
      aria-label={label}
      title={label}
      {...props}
    >
      {icon}
    </Button>
  );
}

/** Confirmation dialog running a bound server action (waive, reset, delete). */
export function FeeConfirm({
  action,
  title,
  description,
  confirmLabel,
  trigger,
  destructive = true,
}: {
  action: Action;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  trigger: ReactNode;
  destructive?: boolean;
}) {
  const tc = useTranslations('common.actions');
  const { open, setOpen, state, formAction } = useDialogAction(action);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <FeeFeedback state={state} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </Button>
            <SubmitButton variant={destructive ? 'destructive' : 'default'}>
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
