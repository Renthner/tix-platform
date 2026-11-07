'use client';

import { CircleAlert, CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ComponentProps, ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fieldErrorOf, type AccountFormState } from '@/lib/account-form';
import { cn } from '@/lib/utils';

/** Form-level error or success message of an account action state. */
export function FormStatus({
  state,
  hideSuccess = false,
}: {
  state: AccountFormState;
  hideSuccess?: boolean;
}) {
  const t = useTranslations('account');
  if (state.status === 'error') {
    // Field-level problems are shown next to the fields.
    if (state.error === 'VALIDATION_FAILED' && state.fieldErrors) return null;
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription>{t(`errors.${state.error}`, state.values ?? {})}</AlertDescription>
      </Alert>
    );
  }
  if (state.status === 'success' && !hideSuccess) {
    return (
      <Alert>
        <CircleCheck />
        <AlertDescription>{t(`messages.${state.message}`, state.values ?? {})}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

/** Labelled input with translated field error (`account.fieldErrors.<code>`). */
export function TextField({
  name,
  label,
  state,
  hint,
  className,
  inputClassName,
  ...inputProps
}: Omit<ComponentProps<typeof Input>, 'name' | 'id'> & {
  name: string;
  label: ReactNode;
  state: AccountFormState;
  hint?: ReactNode;
  /** Classes of the input itself (`className` styles the wrapper). */
  inputClassName?: string;
}) {
  const t = useTranslations('account.fieldErrors');
  const error = fieldErrorOf(state, name);
  const values = state.status === 'error' ? (state.values ?? {}) : {};
  const id = `account-${name}`;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-note` : undefined}
        className={inputClassName}
        {...inputProps}
      />
      {error ? (
        <p id={`${id}-note`} className="text-xs text-destructive" role="alert">
          {t(error, values)}
        </p>
      ) : hint ? (
        <p id={`${id}-note`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
