'use client';

import { useTranslations } from 'next-intl';
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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

/**
 * Submission round of the surrounding <ActionForm>: `round` counts finished submissions, and
 * `claimFocus` lets the first invalid field of a round take the focus.
 */
const ActionFormRound = createContext<{
  round: number;
  claimFocus: (element: HTMLElement) => void;
} | null>(null);

/** The form control a <Field> wraps (by `htmlFor`, else the first control inside). */
function controlOf(wrapper: HTMLElement | null, id: string | undefined): HTMLElement | null {
  if (id) {
    const byId = document.getElementById(id);
    if (byId) return byId;
  }
  return wrapper?.querySelector<HTMLElement>('input, select, textarea, [role="combobox"]') ?? null;
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
  const form = useContext(ActionFormRound);
  const wrapper = useRef<HTMLDivElement>(null);
  // The error stays (red border + message) until the user edits the field.
  const [dismissed, setDismissed] = useState(false);
  const round = form?.round ?? 0;
  const claimFocus = form?.claimFocus;
  useEffect(() => setDismissed(false), [error, round]);
  const shown = error && !dismissed ? error : undefined;
  useEffect(() => {
    if (!shown) return;
    const control = controlOf(wrapper.current, htmlFor);
    if (!control) return;
    control.setAttribute('aria-invalid', 'true');
    claimFocus?.(control);
    const clear = () => setDismissed(true);
    control.addEventListener('input', clear);
    control.addEventListener('change', clear);
    return () => {
      control.removeAttribute('aria-invalid');
      control.removeEventListener('input', clear);
      control.removeEventListener('change', clear);
    };
  }, [shown, round, htmlFor, claimFocus]);
  // A new submit shows the (same) error again – also in plain forms outside <ActionForm>.
  useEffect(() => {
    const formElement = wrapper.current?.closest('form');
    if (!formElement) return;
    const show = () => setDismissed(false);
    formElement.addEventListener('submit', show);
    return () => formElement.removeEventListener('submit', show);
  }, []);
  return (
    <div ref={wrapper} className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {shown ? (
        <p className="text-xs text-destructive" role="alert">
          {t(shown)}
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
  const [round, setRound] = useState(0);
  const wasPending = useRef(false);
  const focusedRound = useRef(-1);
  useEffect(() => {
    if (wasPending.current && !pending) setRound((r) => r + 1);
    wasPending.current = pending;
  }, [pending]);
  const claimFocus = useCallback(
    (element: HTMLElement) => {
      // Fields claim in document order: the first invalid field of a round gets the focus.
      if (focusedRound.current === round) return;
      focusedRound.current = round;
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      element.focus({ preventScroll: true });
    },
    [round],
  );
  const roundValue = useMemo(() => ({ round, claimFocus }), [round, claimFocus]);
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (!resetOnSuccess || resetOnSuccess.status !== 'success') return;
    if (resetOnSuccess.at === lastAt.current) return;
    lastAt.current = resetOnSuccess.at;
    formRef.current?.reset();
  }, [resetOnSuccess]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Submit events of forms rendered in a portal (e.g. confirm dialogs) bubble through the React
    // tree to this form; they belong to their own ActionForm.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    if (pending) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const owned =
      submitter instanceof HTMLElement &&
      'form' in submitter &&
      submitter.form === event.currentTarget;
    const formData = new FormData(event.currentTarget, owned ? (submitter as HTMLElement) : null);
    startTransition(() => action(formData));
  };

  return (
    <ActionFormPending.Provider value={pending}>
      <ActionFormRound.Provider value={roundValue}>
        <form ref={formRef} {...props} onSubmit={onSubmit}>
          {children}
        </form>
      </ActionFormRound.Provider>
    </ActionFormPending.Provider>
  );
}

export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: ReactNode }) {
  const status = useFormStatus();
  const actionFormPending = useContext(ActionFormPending);
  const pending = actionFormPending ?? status.pending;
  const t = useTranslations('common.actions');
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? (pendingLabel ?? t('saving')) : children}
    </Button>
  );
}

/** Shows a toast on success and an alert for form-level errors of an action state. */
export function ActionFeedback({ state }: { state: ActionState }) {
  const tMessages = useTranslations('admin.messages');
  const tForm = useTranslations('admin.errors.form');
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === lastAt.current) return;
    lastAt.current = state.at;
    if (state.status === 'success') toast.success(tMessages(state.message ?? 'saved'));
    else if (!state.formError) toast.error(tForm('validation'));
  }, [state, tMessages, tForm]);
  if (state.status !== 'error' || !state.formError) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{tForm(state.formError)}</AlertDescription>
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
