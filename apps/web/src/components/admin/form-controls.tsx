'use client';

import { useTranslations } from 'next-intl';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useTransition,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useFormStatus } from 'react-dom';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { cn } from '@/lib/utils';

export function errorOf(state: ActionState, name: string): FieldErrorCode | undefined {
  return state.status === 'error' ? state.fieldErrors?.[name] : undefined;
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  error?: FieldErrorCode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations('admin.errors');
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {t(error)}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

/** Pending state of the surrounding <ActionForm> (null outside of one). */
const ActionFormPending = createContext<boolean | null>(null);

/**
 * Form bound to a `useActionState` dispatcher.
 *
 * Unlike `<form action={…}>`, it does NOT let React reset the form after the action:
 * React 19 resets uncontrolled fields (inputs, switches) to their initial defaults after
 * every form action – on validation errors the user's input vanished, and after saving
 * fields briefly showed stale values. Here the user's input always stays; forms that
 * create new items pass `resetOnSuccess` (the action state) to clear themselves.
 */
export function ActionForm({
  action,
  resetOnSuccess,
  children,
  ...props
}: Omit<ComponentProps<'form'>, 'action' | 'onSubmit'> & {
  action: (formData: FormData) => void;
  resetOnSuccess?: ActionState;
}) {
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (!resetOnSuccess || resetOnSuccess.status !== 'success') return;
    if (resetOnSuccess.at === lastAt.current) return;
    lastAt.current = resetOnSuccess.at;
    formRef.current?.reset();
  }, [resetOnSuccess]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => action(formData));
  };

  return (
    <ActionFormPending.Provider value={pending}>
      <form ref={formRef} {...props} onSubmit={onSubmit}>
        {children}
      </form>
    </ActionFormPending.Provider>
  );
}

export function SubmitButton({ children, ...props }: ComponentProps<typeof Button>) {
  const status = useFormStatus();
  const actionFormPending = useContext(ActionFormPending);
  const pending = actionFormPending ?? status.pending;
  const t = useTranslations('common.actions');
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? t('saving') : children}
    </Button>
  );
}

/** Shows a toast on success and an alert for form-level errors of an action state. */
export function ActionFeedback({ state }: { state: ActionState }) {
  const t = useTranslations('admin');
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === lastAt.current) return;
    lastAt.current = state.at;
    if (state.status === 'success') toast.success(t(`messages.${state.message ?? 'saved'}`));
    else if (!state.formError) toast.error(t('errors.form.validation'));
  }, [state, t]);
  if (state.status !== 'error' || !state.formError) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{t(`errors.form.${state.formError}`)}</AlertDescription>
    </Alert>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
