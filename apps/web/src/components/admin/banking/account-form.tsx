'use client';

import { formatIban } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
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
import { Switch } from '@/components/ui/switch';
import { BANKING_IDLE, type BankingActionState } from '@/lib/banking-action-state';
import { BankField, BankingFeedback, bankingError } from './banking-ui';

type Action = (state: BankingActionState, fd: FormData) => Promise<BankingActionState>;

export interface BankAccountFormValues {
  name: string;
  accountHolder: string;
  iban: string;
  bic: string | null;
  bankName: string | null;
  currency: string;
  isDefaultForBankTransfer: boolean;
  isActive: boolean;
}

export function BankAccountForm({
  action,
  initial,
  submitLabel,
}: {
  action: Action;
  initial: BankAccountFormValues;
  submitLabel: string;
}) {
  const t = useTranslations('banking.accounts.form');
  const [state, formAction] = useActionState(action, BANKING_IDLE);
  const err = (name: string) => bankingError(state, name);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <BankingFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <BankField label={t('name')} htmlFor="name" error={err('name')}>
          <Input id="name" name="name" defaultValue={initial.name} required maxLength={120} />
        </BankField>
        <BankField
          label={t('accountHolder')}
          htmlFor="accountHolder"
          error={err('accountHolder')}
          hint={t('accountHolderHint')}
        >
          <Input
            id="accountHolder"
            name="accountHolder"
            defaultValue={initial.accountHolder}
            required
            maxLength={140}
          />
        </BankField>
        <BankField label={t('iban')} htmlFor="iban" error={err('iban')}>
          <Input
            id="iban"
            name="iban"
            defaultValue={initial.iban ? formatIban(initial.iban) : ''}
            required
            maxLength={42}
            className="font-mono uppercase"
            autoComplete="off"
          />
        </BankField>
        <BankField label={t('bic')} htmlFor="bic" error={err('bic')}>
          <Input
            id="bic"
            name="bic"
            defaultValue={initial.bic ?? ''}
            maxLength={11}
            className="font-mono uppercase"
            autoComplete="off"
          />
        </BankField>
        <BankField label={t('bankName')} htmlFor="bankName" error={err('bankName')}>
          <Input
            id="bankName"
            name="bankName"
            defaultValue={initial.bankName ?? ''}
            maxLength={140}
          />
        </BankField>
        <BankField label={t('currency')} htmlFor="currency" error={err('currency')}>
          <Input
            id="currency"
            name="currency"
            defaultValue={initial.currency}
            required
            maxLength={3}
            className="w-24 uppercase"
          />
        </BankField>
      </div>
      <div className="space-y-3">
        <label className="flex items-start gap-3 text-sm">
          <Switch
            name="isDefaultForBankTransfer"
            defaultChecked={initial.isDefaultForBankTransfer}
          />
          <span>
            {t('isDefault')}
            <span className="block text-xs text-muted-foreground">{t('isDefaultHint')}</span>
          </span>
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch name="isActive" defaultChecked={initial.isActive} />
          {t('isActive')}
        </label>
      </div>
      <SubmitButton>{submitLabel}</SubmitButton>
    </ActionForm>
  );
}

/** Confirmation dialog for banking actions (delete, dismiss with note …). */
export function BankingConfirm({
  action,
  title,
  description,
  confirmLabel,
  variant = 'destructive',
  size = 'sm',
  children,
  fields,
}: {
  action: Action;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  children: ReactNode;
  /** Extra inputs inside the dialog (e.g. a note). */
  fields?: (state: BankingActionState) => ReactNode;
}) {
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, BANKING_IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant === 'destructive' ? 'outline' : variant} size={size}>
          {children}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <BankingFeedback state={state} />
          {fields?.(state)}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </Button>
            <SubmitButton variant={variant}>{confirmLabel}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
