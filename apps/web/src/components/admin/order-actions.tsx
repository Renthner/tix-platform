'use client';

import type { OrderStatus } from '@tix/shared';
import {
  Armchair,
  Ban,
  Banknote,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Mail,
  MailCheck,
  MessageSquare,
  Repeat,
  Send,
  Tags,
  Undo2,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { ActionPendingContext } from '@/components/admin/action-dialog-pending';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import {
  OrderEmailChangeForm,
  OrderMessageForm,
} from '@/components/admin/communication/order-communication';
import { TariffChangeForm, type TariffChangeProps } from '@/components/admin/order-adjustment';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { centsToInput } from '@/lib/money';
import { cn } from '@/lib/utils';
import {
  cancelOrderAction,
  cancelPaidOrderAction,
  internalNoteAction,
  keepReservedAction,
  recordPaymentAction,
  resendEmailAction,
  resendTicketsAction,
  revokeAccessLinksAction,
  type OrderActionState,
} from '@/server/admin/orders';
import { ORDER_IDLE, useClosingOrderAction, useOrderFeedback } from './order-action-state';

export interface PaidCancelProps {
  version: number;
  currency: string;
  refundFeesDefault: boolean;
  /** Active (CONFIRMED) items that can still be cancelled. */
  items: { id: string; label: string; detail: string; price: number }[];
}

type DialogKey =
  'payment' | 'resend' | 'resendTickets' | 'tariff' | 'message' | 'email' | 'cancel' | 'paidCancel';

/**
 * Dialog shell of an order action (title + description, the form below). While the form's server
 * action runs (reported via `ActionPendingContext`) the dialog cannot be closed: Escape, overlay
 * clicks and the close button are ignored, so a request is never submitted twice or orphaned.
 */
function ActionDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  title,
  description,
  wide,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  title: ReactNode;
  description?: ReactNode;
  wide?: boolean;
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
        className={cn(wide && 'sm:max-w-xl')}
        data-testid={testId}
        showCloseButton={!pending}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
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

/**
 * Header actions of the admin order page: the one or two actions that matter in the order's
 * state as buttons ("Record payment" while unpaid, "Send tickets again" when paid), the customer
 * view and an "Actions" menu with everything else (destructive cancellation last, in red).
 * Every action opens a dialog; the dialogs live outside the (non-modal) menu with controlled
 * state, so they stay mounted when the menu closes. A dialog closes after a successful action.
 */
export function OrderHeaderActions(props: {
  orderId: string;
  status: OrderStatus;
  version: number;
  outstanding: number;
  currency: string;
  email: string | null;
  customerViewHref: string;
  canRecordPayment: boolean;
  canResend: boolean;
  /** Cancel-and-refund (paid orders); null hides it. */
  paidCancel: PaidCancelProps | null;
  /** Tariff change form (PAID, no open additional payment, allowed role); null hides it. */
  tariffChange: TariffChangeProps | null;
  /**
   * The order has active seat tickets of a seated event (false: only standing spots / admission
   * tickets – there is nothing to change seats for).
   */
  hasMovableSeats?: boolean;
}) {
  const t = useTranslations('orders.admin');
  const tMessage = useTranslations('communication.orderMessage');
  const tEmail = useTranslations('communication.emailChange');
  const [dialog, setDialog] = useState<DialogKey | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // Set when the menu closes because a dialog opens: the focus then goes to the dialog.
  const openingDialog = useRef(false);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // A late success only closes the dialog that started the request, never one opened since.
  const closeIf = (key: DialogKey) => () =>
    setDialog((current) => (current === key ? null : current));
  // Dialogs opened from the menu: the menu item is gone, so the focus returns to "Actions".
  const focusActions = (e: Event) => {
    e.preventDefault();
    actionsTrigger.current?.focus();
  };
  const dialogProps = (key: DialogKey, fromMenu = true) => ({
    open: dialog === key,
    onOpenChange: (open: boolean) => setDialog(open ? key : null),
    onCloseAutoFocus: fromMenu ? focusActions : undefined,
  });
  const openFromMenu = (key: DialogKey | 'revoke') => {
    openingDialog.current = true;
    if (key === 'revoke') setRevokeOpen(true);
    else setDialog(key);
  };

  const open = props.status === 'PENDING' || props.status === 'AWAITING_PAYMENT';
  const paid = props.status === 'PAID' || props.status === 'PARTIALLY_REFUNDED';
  const canPay =
    props.canRecordPayment && (open || (props.status === 'PAID' && props.outstanding > 0));
  const canChangeSeats = (open || paid) && props.hasMovableSeats !== false;
  const canPaidCancel = Boolean(props.paidCancel) && paid;

  // A dialog whose action is no longer offered (e.g. the status changed on revalidation) is
  // forgotten, so it cannot reappear by itself once the action is offered again.
  const available: Record<DialogKey, boolean> = {
    payment: canPay,
    resend: props.canResend,
    resendTickets: paid,
    tariff: Boolean(props.tariffChange),
    message: Boolean(props.email),
    email: true,
    cancel: open,
    paidCancel: canPaidCancel && Boolean(props.paidCancel),
  };
  const dialogGone = dialog !== null && !available[dialog];
  useEffect(() => {
    if (dialogGone) setDialog(null);
  }, [dialogGone]);

  return (
    <>
      {canPay && (
        <Button
          type="button"
          onClick={() => setDialog('payment')}
          data-testid="order-record-payment"
        >
          <Banknote /> {t('actions.payment.title')}
        </Button>
      )}
      {paid && (
        <Button
          type="button"
          variant={canPay ? 'outline' : 'default'}
          onClick={() => setDialog('resendTickets')}
          data-testid="order-resend-tickets"
        >
          <MailCheck /> {t('actions.resendTickets.title')}
        </Button>
      )}
      <Button asChild variant="outline">
        <a href={props.customerViewHref} target="_blank" rel="noopener">
          <ExternalLink /> {t('customerView')}
        </a>
      </Button>
      {/* Not modal: a modal menu that closes while a dialog opens can leave the page inert. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button ref={actionsTrigger} type="button" variant="outline" data-testid="order-actions">
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
          {props.canResend && (
            <DropdownMenuItem onSelect={() => openFromMenu('resend')}>
              <Repeat /> {t('actions.resend.title')}
            </DropdownMenuItem>
          )}
          {props.email && (
            <DropdownMenuItem onSelect={() => openFromMenu('message')}>
              <MessageSquare /> {tMessage('title')}
            </DropdownMenuItem>
          )}
          {canChangeSeats && (
            <DropdownMenuItem asChild>
              <Link href={`/admin/orders/${props.orderId}/change-seats`}>
                <Armchair /> {t('actions.changeSeats.title')}
              </Link>
            </DropdownMenuItem>
          )}
          {props.tariffChange && (
            <DropdownMenuItem onSelect={() => openFromMenu('tariff')}>
              <Tags /> {t('adjustment.title')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => openFromMenu('email')}>
            <Mail /> {tEmail('title')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={revoking} onSelect={() => openFromMenu('revoke')}>
            <KeyRound /> {t('actions.revokeLinks.title')}
          </DropdownMenuItem>
          {(open || canPaidCancel) && <DropdownMenuSeparator />}
          {open && (
            <DropdownMenuItem variant="destructive" onSelect={() => openFromMenu('cancel')}>
              <Ban /> {t('actions.cancel.title')}
            </DropdownMenuItem>
          )}
          {canPaidCancel && (
            <DropdownMenuItem variant="destructive" onSelect={() => openFromMenu('paidCancel')}>
              <Undo2 /> {t('actions.cancelPaid.title')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {canPay && (
        <ActionDialog
          {...dialogProps('payment', false)}
          testId="order-dialog-payment"
          title={t('actions.payment.title')}
          description={t('actions.payment.description')}
        >
          <PaymentForm
            orderId={props.orderId}
            outstanding={props.outstanding}
            currency={props.currency}
            onSuccess={closeIf('payment')}
          />
        </ActionDialog>
      )}
      {props.canResend && (
        <ActionDialog
          {...dialogProps('resend')}
          testId="order-dialog-resend"
          title={t('actions.resend.title')}
          description={t('actions.resend.description')}
        >
          <SimpleActionForm
            action={resendEmailAction.bind(null, props.orderId)}
            label={t('actions.resend.submit')}
            icon={<Send />}
            onSuccess={closeIf('resend')}
          />
        </ActionDialog>
      )}
      {paid && (
        <ActionDialog
          {...dialogProps('resendTickets', false)}
          testId="order-dialog-resend-tickets"
          title={t('actions.resendTickets.title')}
          description={t('actions.resendTickets.description')}
        >
          <SimpleActionForm
            action={resendTicketsAction.bind(null, props.orderId)}
            label={t('actions.resendTickets.submit')}
            icon={<Send />}
            onSuccess={closeIf('resendTickets')}
          />
        </ActionDialog>
      )}
      {props.email && (
        <ActionDialog
          {...dialogProps('message')}
          testId="order-dialog-message"
          title={tMessage('title')}
          description={tMessage('description')}
          wide
        >
          <OrderMessageForm orderId={props.orderId} onSuccess={closeIf('message')} />
        </ActionDialog>
      )}
      {props.tariffChange && (
        <ActionDialog
          {...dialogProps('tariff')}
          testId="order-dialog-tariff"
          title={t('adjustment.title')}
          description={t('adjustment.description')}
          wide
        >
          <TariffChangeForm {...props.tariffChange} onSuccess={closeIf('tariff')} />
        </ActionDialog>
      )}
      <ActionDialog
        {...dialogProps('email')}
        testId="order-dialog-email"
        title={tEmail('title')}
        description={tEmail('description')}
      >
        <OrderEmailChangeForm
          orderId={props.orderId}
          version={props.version}
          currentEmail={props.email}
          onSuccess={closeIf('email')}
        />
      </ActionDialog>
      {open && (
        <ActionDialog
          {...dialogProps('cancel')}
          testId="order-dialog-cancel"
          title={t('actions.cancel.title')}
          description={t('actions.cancel.description')}
        >
          <CancelForm orderId={props.orderId} onSuccess={closeIf('cancel')} />
        </ActionDialog>
      )}
      {canPaidCancel && props.paidCancel && (
        <ActionDialog
          {...dialogProps('paidCancel')}
          testId="order-dialog-cancel-paid"
          title={t('actions.cancelPaid.title')}
          description={t('actions.cancelPaid.description')}
          wide
        >
          <PaidCancelForm
            orderId={props.orderId}
            {...props.paidCancel}
            onSuccess={closeIf('paidCancel')}
          />
        </ActionDialog>
      )}
      <RevokeLinksDialog
        orderId={props.orderId}
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        onCloseAutoFocus={focusActions}
        onPendingChange={setRevoking}
      />
    </>
  );
}

/** Dialog body with only a submit button (resend e-mail / tickets). */
function SimpleActionForm({
  action: bound,
  label,
  icon,
  onSuccess,
}: {
  action: Parameters<typeof useClosingOrderAction>[0];
  label: string;
  icon?: ReactNode;
  onSuccess: () => void;
}) {
  const [, action] = useClosingOrderAction(bound, onSuccess);
  return (
    <ActionForm action={action} className="flex justify-end">
      <SubmitButton size="sm">
        {icon} {label}
      </SubmitButton>
    </ActionForm>
  );
}

function RevokeLinksDialog({
  orderId,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onPendingChange,
}: {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** Reports while the revocation runs (the menu item is disabled meanwhile). */
  onPendingChange: (pending: boolean) => void;
}) {
  const t = useTranslations('orders.admin.actions.revokeLinks');
  const [, action, actionPending] = useClosingOrderAction(
    revokeAccessLinksAction.bind(null, orderId),
  );
  const [transitionPending, startTransition] = useTransition();
  const pending = transitionPending || actionPending;
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      title={t('confirmTitle')}
      description={t('confirmDescription')}
      confirmLabel={t('submit')}
      onConfirm={() => startTransition(() => action(new FormData()))}
    />
  );
}

/**
 * "Keep reserved" of an unpaid bank-transfer order: a switch row inside the payment card (it is
 * a state, not an action). An optional reason and "Save" appear once the switch was changed.
 */
export function KeepReservedSwitch({
  orderId,
  keepReserved,
  keepReservedReason,
}: {
  orderId: string;
  keepReserved: boolean;
  keepReservedReason: string | null;
}) {
  const t = useTranslations('orders.admin.actions.keepReserved');
  const [keep, setKeep] = useState(keepReserved);
  const [editing, setEditing] = useState(false);
  const [state, action] = useActionState(async (prev: OrderActionState, formData: FormData) => {
    const result = await keepReservedAction(orderId, prev, formData);
    if (result.status === 'success') setEditing(false);
    return result;
  }, ORDER_IDLE);
  useOrderFeedback(state);
  return (
    <ActionForm
      action={action}
      className="space-y-2 rounded-md border bg-muted/40 p-3"
      data-testid="order-keep-reserved"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="keep" className="font-medium">
            {t('label')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <Switch
          id="keep"
          name="keep"
          checked={keep}
          onCheckedChange={(value) => {
            setKeep(value);
            setEditing(true);
          }}
        />
      </div>
      {keep && (editing || keepReservedReason) && (
        <Input
          name="reason"
          defaultValue={keepReservedReason ?? ''}
          maxLength={500}
          placeholder={t('reason')}
          aria-label={t('reason')}
          onChange={() => setEditing(true)}
        />
      )}
      {editing && <SubmitButton size="sm">{t('save')}</SubmitButton>}
    </ActionForm>
  );
}

function PaymentForm({
  orderId,
  outstanding,
  currency,
  onSuccess,
}: {
  orderId: string;
  outstanding: number;
  currency: string;
  onSuccess: () => void;
}) {
  const t = useTranslations('orders.admin.actions.payment');
  const tMethod = useTranslations('orders.method');
  const [, action] = useClosingOrderAction(recordPaymentAction.bind(null, orderId), onSuccess);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ActionForm action={action} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="pay-amount">
            {t('amount')} ({currency})
          </Label>
          <Input
            id="pay-amount"
            name="amount"
            inputMode="decimal"
            defaultValue={outstanding > 0 ? centsToInput(outstanding) : ''}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pay-date">{t('date')}</Label>
          <Input id="pay-date" name="receivedOn" type="date" defaultValue={today} max={today} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pay-method">{t('method')}</Label>
        <select
          id="pay-method"
          name="method"
          defaultValue="BANK_TRANSFER"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {(['BANK_TRANSFER', 'CASH', 'CARD', 'PAYPAL'] as const).map((m) => (
            <option key={m} value={m}>
              {tMethod(m)}
            </option>
          ))}
        </select>
      </div>
      <Input name="note" maxLength={500} placeholder={t('note')} aria-label={t('note')} />
      <div className="flex justify-end">
        <SubmitButton size="sm">{t('submit')}</SubmitButton>
      </div>
    </ActionForm>
  );
}

function CancelForm({ orderId, onSuccess }: { orderId: string; onSuccess: () => void }) {
  const t = useTranslations('orders.admin.actions.cancel');
  const [, action] = useClosingOrderAction(cancelOrderAction.bind(null, orderId), onSuccess);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <ActionForm action={action} className="space-y-3">
      <Textarea
        name="reason"
        rows={2}
        maxLength={500}
        placeholder={t('reason')}
        aria-label={t('reason')}
      />
      <div className="flex items-center gap-2">
        <Checkbox id="cancel-notify" name="notify" defaultChecked />
        <Label htmlFor="cancel-notify" className="font-normal">
          {t('notify')}
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="cancel-confirm"
          checked={confirmed}
          onCheckedChange={(v) => setConfirmed(v === true)}
        />
        <Label htmlFor="cancel-confirm" className="font-normal">
          {t('confirm')}
        </Label>
      </div>
      <div className="flex justify-end">
        <SubmitButton size="sm" variant="destructive" disabled={!confirmed}>
          {t('submit')}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

function PaidCancelForm({
  orderId,
  version,
  currency,
  refundFeesDefault,
  items,
  onSuccess,
}: { orderId: string; onSuccess: () => void } & PaidCancelProps) {
  const t = useTranslations('orders.admin.actions.cancelPaid');
  const format = useFormatter();
  const [, action] = useClosingOrderAction(cancelPaidOrderAction.bind(null, orderId), onSuccess);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmed, setConfirmed] = useState(false);
  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  const sum = items.filter((i) => selected.has(i.id)).reduce((total, i) => total + i.price, 0);
  const allSelected = items.length > 0 && selected.size === items.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noActiveItems')}</p>;
  }
  return (
    <ActionForm action={action} className="space-y-3">
      <input type="hidden" name="expectedVersion" value={version} />
      {[...selected].map((id) => (
        <input key={id} type="hidden" name="orderItemIds" value={id} />
      ))}
      <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
        <div className="flex items-center gap-2 border-b pb-2">
          <Checkbox
            id="paid-cancel-all"
            checked={allSelected}
            onCheckedChange={(v) =>
              setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())
            }
          />
          <Label htmlFor="paid-cancel-all" className="font-medium">
            {t('selectAll')}
          </Label>
        </div>
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-2">
            <Checkbox
              id={`paid-cancel-${item.id}`}
              checked={selected.has(item.id)}
              onCheckedChange={(v) => toggle(item.id, v === true)}
              className="mt-0.5"
            />
            <Label
              htmlFor={`paid-cancel-${item.id}`}
              className="flex-1 items-start justify-between gap-2 font-normal"
            >
              <span>
                {item.label}
                <span className="block text-xs text-muted-foreground">{item.detail}</span>
              </span>
              <span className="tabular-nums">{money(item.price)}</span>
            </Label>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{t('selection', { count: selected.size })}</span>
        <span className="text-right">
          <span className="font-semibold tabular-nums">{money(sum)}</span>
          <span className="block text-xs text-muted-foreground">{t('feesNote')}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="paid-cancel-fees" name="refundFees" defaultChecked={refundFeesDefault} />
        <Label htmlFor="paid-cancel-fees" className="font-normal">
          {t('refundFees')}
        </Label>
      </div>
      <Textarea
        name="reason"
        rows={2}
        maxLength={500}
        placeholder={t('reason')}
        aria-label={t('reason')}
      />
      <div className="flex items-center gap-2">
        <Checkbox id="paid-cancel-notify" name="notify" defaultChecked />
        <Label htmlFor="paid-cancel-notify" className="font-normal">
          {t('notify')}
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="paid-cancel-confirm"
          name="confirmed"
          checked={confirmed}
          onCheckedChange={(v) => setConfirmed(v === true)}
        />
        <Label htmlFor="paid-cancel-confirm" className="font-normal">
          {t('confirm')}
        </Label>
      </div>
      <div className="flex justify-end">
        <SubmitButton size="sm" variant="destructive" disabled={!confirmed || selected.size === 0}>
          {t('submit')}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

/** Internal note of the order (aside of the order page; only visible to admins). */
export function InternalNoteForm({ orderId, note }: { orderId: string; note: string | null }) {
  const t = useTranslations('orders.admin.actions.note');
  const [state, action] = useActionState(internalNoteAction.bind(null, orderId), ORDER_IDLE);
  useOrderFeedback(state);
  return (
    <ActionForm action={action} className="space-y-2" data-testid="order-internal-note">
      <Textarea
        name="note"
        rows={4}
        maxLength={4000}
        defaultValue={note ?? ''}
        aria-label={t('title')}
        placeholder={t('description')}
      />
      <SubmitButton size="sm" variant="outline">
        {t('submit')}
      </SubmitButton>
    </ActionForm>
  );
}
