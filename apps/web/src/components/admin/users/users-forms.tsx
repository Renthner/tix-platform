'use client';

import { ADMIN_ROLES, type AdminRole } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ErrorAlert } from '@/components/admin/auth/password-link-forms';
import { ActionForm, Field, SubmitButton } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SECURITY_IDLE, type SecurityState } from '@/lib/security-state';
import type { UserOperation } from '@/server/admin/users';

type Action = (state: SecurityState, fd: FormData) => Promise<SecurityState>;

function useSuccessToast(state: SecurityState) {
  const t = useTranslations('adminSecurity.messages');
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status !== 'success' || state.at === last.current) return;
    last.current = state.at;
    if (state.message) toast.success(t(state.message as 'invited'));
  }, [state, t]);
}

function RoleChecks({ defaultRoles }: { defaultRoles: readonly AdminRole[] }) {
  const t = useTranslations('adminSecurity.users');
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('roles')}</legend>
      {ADMIN_ROLES.map((role) => (
        <label key={role} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="roles"
            value={role}
            defaultChecked={defaultRoles.includes(role)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{t(`role.${role}`)}</span>
            <span className="block text-xs text-muted-foreground">{t(`roleHint.${role}`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function InviteUserForm({ action }: { action: Action }) {
  const t = useTranslations('adminSecurity.users.invite');
  const [state, formAction] = useActionState(action, SECURITY_IDLE);
  useSuccessToast(state);
  return (
    <ActionForm
      action={formAction}
      resetOnSuccess={state.status === 'success' ? { status: 'success', at: state.at } : undefined}
      className="max-w-md space-y-4"
    >
      <ErrorAlert state={state} />
      <Field label={t('displayName')} htmlFor="invite-name">
        <Input id="invite-name" name="displayName" maxLength={120} required />
      </Field>
      <Field label={t('email')} htmlFor="invite-email">
        <Input id="invite-email" name="email" type="email" maxLength={254} required />
      </Field>
      <RoleChecks defaultRoles={['EVENT_MANAGER']} />
      <SubmitButton pendingLabel={t('sending')}>{t('submit')}</SubmitButton>
    </ActionForm>
  );
}

export function EditUserForm({
  action,
  displayName,
  roles,
}: {
  action: Action;
  displayName: string;
  roles: AdminRole[];
}) {
  const t = useTranslations('adminSecurity.users.edit');
  const [state, formAction] = useActionState(action, SECURITY_IDLE);
  useSuccessToast(state);
  return (
    <ActionForm action={formAction} className="max-w-md space-y-4">
      <ErrorAlert state={state} />
      <Field label={t('displayName')} htmlFor="edit-name">
        <Input
          id="edit-name"
          name="displayName"
          defaultValue={displayName}
          maxLength={120}
          required
        />
      </Field>
      <RoleChecks defaultRoles={roles} />
      <p className="text-xs text-muted-foreground">{t('rolesNote')}</p>
      <SubmitButton>{t('save')}</SubmitButton>
    </ActionForm>
  );
}

/** Row of single-click operations; destructive ones ask for confirmation. */
export function UserOperations({
  userId,
  isActive,
  invitePending,
  canDeleteInvite,
  hasTwoFactor,
  locked,
  self,
  run,
}: {
  userId: string;
  isActive: boolean;
  invitePending: boolean;
  canDeleteInvite: boolean;
  hasTwoFactor: boolean;
  locked: boolean;
  self: boolean;
  run: (id: string, op: UserOperation) => Promise<SecurityState>;
}) {
  const t = useTranslations('adminSecurity.users.operations');
  const [state, setState] = useState<SecurityState>(SECURITY_IDLE);
  const [pending, startTransition] = useTransition();
  useSuccessToast(state);

  const op = (operation: UserOperation, confirmKey?: string) => () => {
    if (confirmKey && !window.confirm(t(confirmKey as 'confirmDeactivate'))) return;
    startTransition(async () => setState(await run(userId, operation)));
  };

  return (
    <div className="space-y-3">
      <ErrorAlert state={state} />
      <div className="flex flex-wrap gap-2">
        {invitePending && isActive && (
          <Button type="button" variant="outline" disabled={pending} onClick={op('resendInvite')}>
            {t('resendInvite')}
          </Button>
        )}
        {isActive ? (
          !self && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={op('deactivate', 'confirmDeactivate')}
            >
              {t('deactivate')}
            </Button>
          )
        ) : (
          <Button type="button" variant="outline" disabled={pending} onClick={op('activate')}>
            {t('activate')}
          </Button>
        )}
        {locked && (
          <Button type="button" variant="outline" disabled={pending} onClick={op('unlock')}>
            {t('unlock')}
          </Button>
        )}
        {hasTwoFactor && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={op('resetTwoFactor', 'confirmResetTwoFactor')}
          >
            {t('resetTwoFactor')}
          </Button>
        )}
        {canDeleteInvite && (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={op('deleteInvite', 'confirmDeleteInvite')}
          >
            {t('deleteInvite')}
          </Button>
        )}
      </div>
    </div>
  );
}
