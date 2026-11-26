'use client';

import { ADMIN_ROLES, type AdminRole } from '@tix/shared';
import {
  ChevronDown,
  KeyRound,
  LogOut,
  Mail,
  Trash2,
  Unlock,
  UserCheck,
  UserPlus,
  UserX,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  ActionPendingContext,
  useReportActionPending,
} from '@/components/admin/action-dialog-pending';
import { ErrorAlert } from '@/components/admin/auth/password-link-forms';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ActionForm, Field, SubmitButton } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

export function InviteUserForm({
  action,
  onSuccess,
}: {
  action: Action;
  /** Runs once per successful invitation (e.g. closes the surrounding dialog). */
  onSuccess?: () => void;
}) {
  const t = useTranslations('adminSecurity.users.invite');
  const [state, formAction, pending] = useActionState(action, SECURITY_IDLE);
  useSuccessToast(state);
  // Inside a dialog host: the dialog cannot be closed while the invitation is being sent.
  useReportActionPending(pending);
  const lastSuccess = useRef<number | null>(null);
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });
  useEffect(() => {
    if (state.status !== 'success' || state.at === lastSuccess.current) return;
    lastSuccess.current = state.at;
    onSuccessRef.current?.();
  }, [state]);
  return (
    <ActionForm
      action={formAction}
      resetOnSuccess={state.status === 'success' ? { status: 'success', at: state.at } : undefined}
      className="space-y-4"
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

/**
 * Dialog shell whose form reports its pending state (`ActionPendingContext`): while the request
 * runs, Escape, overlay clicks and the close button are ignored.
 */
function PendingLockDialog({
  open,
  onOpenChange,
  title,
  description,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        data-testid={testId}
        showCloseButton={!pending}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ActionPendingContext.Provider value={setPending}>{children}</ActionPendingContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

/** "Invite user" header button; the form opens in a dialog that closes after a successful send. */
export function InviteUserDialog({ action }: { action: Action }) {
  const t = useTranslations('adminSecurity.users.invite');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} data-testid="users-invite">
        <UserPlus /> {t('open')}
      </Button>
      <PendingLockDialog
        open={open}
        onOpenChange={setOpen}
        title={t('title')}
        description={t('description')}
        testId="users-invite-dialog"
      >
        <InviteUserForm action={action} onSuccess={() => setOpen(false)} />
      </PendingLockDialog>
    </>
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

type Asking = { operation: UserOperation; confirmKey: string; labelKey: string };

/**
 * Header actions of the user detail page: the one operation that matters in the account's state
 * as a button (resend invitation, unlock or reactivate) and an "Actions" menu with the others
 * (destructive deletion last, in red). Confirmations use a dialog outside the (non-modal) menu.
 * Errors are reported as a toast; the controls are disabled while an operation runs.
 */
export function UserHeaderActions({
  userId,
  isActive,
  invitePending,
  canDeleteInvite,
  hasTwoFactor,
  locked,
  self,
  activeSessions = 0,
  run,
}: {
  userId: string;
  isActive: boolean;
  invitePending: boolean;
  canDeleteInvite: boolean;
  hasTwoFactor: boolean;
  locked: boolean;
  self: boolean;
  /** Sessions still valid; the sign-out action is offered when there are any (never for yourself). */
  activeSessions?: number;
  run: (id: string, op: UserOperation) => Promise<SecurityState>;
}) {
  const t = useTranslations('adminSecurity.users.operations');
  const tErrors = useTranslations('adminSecurity.errors');
  const [state, setState] = useState<SecurityState>(SECURITY_IDLE);
  const [pending, startTransition] = useTransition();
  useSuccessToast(state);
  const lastError = useRef<number | null>(null);
  useEffect(() => {
    if (state.status !== 'error' || state.at === lastError.current) return;
    lastError.current = state.at;
    toast.error(tErrors(state.code, { min: state.min ?? 0 }));
  }, [state, tErrors]);

  const [asking, setAsking] = useState<Asking | null>(null);
  // Set when the menu closes because a dialog opens: the focus then goes to the dialog.
  const openingDialog = useRef(false);
  const actionsTrigger = useRef<HTMLButtonElement>(null);

  const execute = (operation: UserOperation) =>
    startTransition(async () => setState(await run(userId, operation)));
  const ask = (operation: UserOperation, confirmKey: string) => {
    openingDialog.current = true;
    setAsking({ operation, confirmKey, labelKey: operation });
  };

  // The one state-driven primary action (same visibility rules as before).
  const primary: UserOperation | null =
    invitePending && isActive ? 'resendInvite' : locked ? 'unlock' : !isActive ? 'activate' : null;
  const primaryIcon = { resendInvite: Mail, unlock: Unlock, activate: UserCheck } as const;

  const items: { op: UserOperation; confirmKey?: string; icon: typeof Mail; testId?: string }[] =
    [];
  if (invitePending && isActive && primary !== 'resendInvite')
    items.push({ op: 'resendInvite', icon: Mail });
  if (locked && primary !== 'unlock') items.push({ op: 'unlock', icon: Unlock });
  if (!isActive && primary !== 'activate') items.push({ op: 'activate', icon: UserCheck });
  if (hasTwoFactor)
    items.push({ op: 'resetTwoFactor', confirmKey: 'confirmResetTwoFactor', icon: KeyRound });
  if (!self && activeSessions > 0)
    items.push({
      op: 'signOutAll',
      confirmKey: 'confirmSignOutAll',
      icon: LogOut,
      testId: 'user-sign-out-all',
    });
  if (isActive && !self)
    items.push({ op: 'deactivate', confirmKey: 'confirmDeactivate', icon: UserX });

  const PrimaryIcon = primary ? primaryIcon[primary as keyof typeof primaryIcon] : null;

  return (
    <>
      {primary && PrimaryIcon && (
        <Button
          type="button"
          disabled={pending}
          onClick={() => execute(primary)}
          data-testid={`user-${primary}`}
        >
          <PrimaryIcon /> {t(primary as 'unlock')}
        </Button>
      )}
      {(items.length > 0 || canDeleteInvite) && (
        // Not modal: a modal menu that closes while a dialog opens can leave the page inert.
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={actionsTrigger}
              type="button"
              variant="outline"
              disabled={pending}
              data-testid="user-actions"
            >
              {t('menu')} <ChevronDown />
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
            {items.map(({ op, confirmKey, icon: Icon, testId }) => (
              <DropdownMenuItem
                key={op}
                data-testid={testId}
                onSelect={() => (confirmKey ? ask(op, confirmKey) : execute(op))}
              >
                <Icon /> {t(op as 'unlock')}
              </DropdownMenuItem>
            ))}
            {canDeleteInvite && (
              <>
                {items.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => ask('deleteInvite', 'confirmDeleteInvite')}
                >
                  <Trash2 /> {t('deleteInvite')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        description={asking ? t(asking.confirmKey as 'confirmDeactivate') : null}
        confirmLabel={asking ? t(asking.labelKey as 'deactivate') : null}
        onConfirm={() => {
          if (asking) execute(asking.operation);
        }}
        onCloseAutoFocus={(e) => {
          // The menu item is gone: the focus returns to the "Actions" button.
          e.preventDefault();
          actionsTrigger.current?.focus();
        }}
      />
    </>
  );
}
