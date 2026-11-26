'use client';

import { ChevronDown, Download, KeyRound, MailCheck, Unlock, UserX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  customerAccountAction,
  type CustomerAccountOperation,
  type CustomerActionState,
} from '@/server/admin/customers';

const IDLE: CustomerActionState = { status: 'idle' };

/**
 * Header actions of the customer page: the GDPR export (if allowed) and an "Actions" menu with the
 * one-click account operations. The remove-login confirmation lives outside the menu (controlled),
 * so it stays mounted when the menu closes.
 */
export function CustomerHeaderActions({
  customerId,
  hasAccount,
  verified,
  locked,
  anonymized,
  exportHref,
}: {
  customerId: string;
  hasAccount: boolean;
  verified: boolean;
  locked: boolean;
  anonymized: boolean;
  /** GDPR export download (Art. 15); null when the admin may not export. */
  exportHref: string | null;
}) {
  const t = useTranslations('customers');
  const [pending, start] = useTransition();
  const [state, setState] = useActionState(
    async (_prev: CustomerActionState, op: CustomerAccountOperation) =>
      customerAccountAction(customerId, op),
    IDLE,
  );
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === last.current) return;
    last.current = state.at;
    if (state.status === 'success') toast.success(t(`messages.${state.message}` as never));
    else if (t.has(`errors.${state.code}` as never))
      toast.error(t(`errors.${state.code}` as never));
    else toast.error(t('errors.INTERNAL_ERROR'));
  }, [state, t]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Set when the menu closes because the dialog opens: the focus then goes to the dialog.
  const openingDialog = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const run = (op: CustomerAccountOperation) => () => start(() => setState(op));

  const accountOps = !anonymized && (hasAccount || locked);
  return (
    <>
      {exportHref && (
        <Button asChild variant="outline">
          <a href={exportHref} download data-testid="customer-gdpr-export">
            <Download /> {t('gdpr.export')}
          </a>
        </Button>
      )}
      {accountOps && (
        // Not modal: a modal menu that closes while a dialog opens can leave the page inert.
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              type="button"
              variant="outline"
              disabled={pending}
              data-testid="customer-actions"
            >
              {t('actionsMenu')} <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-56"
            onCloseAutoFocus={(e) => {
              if (openingDialog.current) e.preventDefault();
              openingDialog.current = false;
            }}
          >
            {hasAccount && !verified && (
              <DropdownMenuItem disabled={pending} onSelect={run('resendVerification')}>
                <MailCheck /> {t('account.resendVerification')}
              </DropdownMenuItem>
            )}
            {hasAccount && (
              <DropdownMenuItem disabled={pending} onSelect={run('sendPasswordReset')}>
                <KeyRound /> {t('account.sendPasswordReset')}
              </DropdownMenuItem>
            )}
            {locked && (
              <DropdownMenuItem disabled={pending} onSelect={run('unlock')}>
                <Unlock /> {t('account.unlock')}
              </DropdownMenuItem>
            )}
            {hasAccount && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={pending}
                  onSelect={() => {
                    openingDialog.current = true;
                    setConfirmRemove(true);
                  }}
                >
                  <UserX /> {t('account.removeLogin')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        description={t('account.removeLoginConfirm')}
        confirmLabel={t('account.removeLogin')}
        onConfirm={run('removeLogin')}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          trigger.current?.focus();
        }}
      />
    </>
  );
}
