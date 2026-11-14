'use client';

import type { BankTxMatchStatus, BankTxReviewReason, MatchCandidateReason } from '@tix/shared';
import { Search } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useState, useTransition, type ReactNode } from 'react';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { BANKING_IDLE } from '@/lib/banking-action-state';
import { parseMoneyToCents } from '@/lib/money';
import {
  assignAdjustmentAction,
  assignTransactionAction,
  ignoreTransactionAction,
  rematchTransactionAction,
  resolveTransactionAction,
  searchAssignableOrders,
  type AssignableOrder,
} from '@/server/admin/banking-actions';
import { BankingConfirm } from './account-form';
import { BankingActionButton } from './connection-actions';
import { ReverseAllocationButton } from './reverse-allocation';
import {
  BankField,
  BankingFeedback,
  MatchStatusBadge,
  Money,
  ReasonBadge,
  bankingError,
} from './banking-ui';

export interface CandidateView {
  orderId: string;
  orderNumber: string;
  score: number;
  reasons: MatchCandidateReason[];
  order: AssignableOrder | null;
  /** The candidate is the open additional payment (tariff change) of this order. */
  adjustmentId?: string;
}

export interface AllocationItemView {
  id: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  method: string;
  note: string | null;
  reversed: boolean;
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
}

export interface ReviewCaseView {
  id: string;
  bookingDate: string;
  amount: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  remittanceInformation: string | null;
  endToEndId: string | null;
  extractedReference: string | null;
  matchStatus: BankTxMatchStatus;
  reviewReason: BankTxReviewReason | null;
  reviewNote: string | null;
  accountName: string;
  candidates: CandidateView[];
  allocations: AllocationItemView[];
  unassigned: number;
}

const PAYABLE = ['PENDING', 'AWAITING_PAYMENT', 'PAID'];

/** One Klärfall: details, scored suggestions, order search, assign / dismiss / re-run. */
export function ReviewCase({
  view,
  showDetailsLink = true,
}: {
  view: ReviewCaseView;
  showDetailsLink?: boolean;
}) {
  const t = useTranslations('banking.review');
  const tr = useTranslations('banking.candidateReason');
  const format = useFormatter();
  const [amountInput, setAmountInput] = useState('');
  const [note, setNote] = useState('');
  const amountCents = amountInput.trim() ? parseMoneyToCents(amountInput) : null;
  const effective = amountCents ?? view.unassigned;
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: view.currency });
  const open = view.matchStatus === 'NEEDS_REVIEW' || view.matchStatus === 'UNMATCHED';
  const credit = view.amount > 0;
  // Fully allocated but still in review (OVERPAYMENT after ALREADY_PAID): nothing to assign.
  const activeAllocations = view.allocations.filter((a) => !a.reversed);
  const fullyAllocated = open && credit && activeAllocations.length > 0 && view.unassigned <= 0;
  const allocatedOrders = [
    ...new Map(activeAllocations.map((a) => [a.orderId, a.orderNumber])).entries(),
  ];

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Money
                cents={view.amount}
                currency={view.currency}
                signed
                className="text-lg font-semibold"
              />
              <span className="text-sm text-muted-foreground">
                {format.dateTime(new Date(`${view.bookingDate}T12:00:00Z`), {
                  dateStyle: 'medium',
                })}{' '}
                · {view.accountName}
              </span>
            </div>
            <div className="text-sm">
              <span className="font-medium">{view.counterpartyName ?? '–'}</span>
              {view.counterpartyIban ? (
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {view.counterpartyIban}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <MatchStatusBadge status={view.matchStatus} />
            {view.reviewReason && view.matchStatus === 'NEEDS_REVIEW' ? (
              <ReasonBadge reason={view.reviewReason} />
            ) : null}
          </div>
        </div>
        {view.remittanceInformation || view.endToEndId ? (
          <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs">
            {view.remittanceInformation}
            {view.endToEndId ? (
              <span className="block text-muted-foreground">E2E: {view.endToEndId}</span>
            ) : null}
          </p>
        ) : null}
        {view.extractedReference ? (
          <p className="text-xs text-muted-foreground">
            {t('reference')}: <span className="font-mono">{view.extractedReference}</span>
          </p>
        ) : null}
        {view.allocations.length > 0 ? (
          <div className="space-y-1 text-sm">
            <div className="font-medium">{t('allocations')}</div>
            {view.allocations.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5"
              >
                <div className={a.reversed ? 'opacity-60' : ''}>
                  <span className={a.reversed ? 'line-through' : ''}>
                    <Link href={`/admin/orders/${a.orderId}`} className="hover:underline">
                      {a.orderNumber}
                    </Link>{' '}
                    · {money(a.amount)} · {a.method}
                  </span>
                  {a.note ? <span className="text-muted-foreground"> – {a.note}</span> : null}
                  {a.reversed ? (
                    <div className="text-xs text-muted-foreground">
                      {t('reversedInfo', {
                        who: a.reversedBy ?? '–',
                        when: a.reversedAt
                          ? format.dateTime(new Date(a.reversedAt), {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : '–',
                      })}
                      {a.reversalReason ? ` – ${a.reversalReason}` : ''}
                    </div>
                  ) : null}
                </div>
                {!a.reversed ? (
                  <ReverseAllocationButton allocationId={a.id} orderNumber={a.orderNumber} />
                ) : null}
              </div>
            ))}
            {view.unassigned > 0 ? (
              <div className="font-medium text-destructive">
                {t('unassigned', { amount: money(view.unassigned) })}
              </div>
            ) : null}
          </div>
        ) : null}

        {fullyAllocated ? (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>{t('fullyAllocated')}</p>
            <div className="flex flex-wrap gap-2">
              {allocatedOrders.map(([orderId, orderNumber]) => (
                <Button key={orderId} asChild variant="outline" size="sm">
                  <Link href={`/admin/orders/${orderId}`}>
                    {t('openOrder', { order: orderNumber })}
                  </Link>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {open && credit && !fullyAllocated ? (
          <>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t('candidates')}</div>
              {view.candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noCandidates')}</p>
              ) : (
                <div className="divide-y rounded-md border">
                  {view.candidates.map((c) => (
                    <OrderRow
                      key={c.orderId}
                      transactionId={view.id}
                      order={c.order}
                      adjustmentId={c.adjustmentId}
                      fallbackNumber={c.orderNumber}
                      amount={effective}
                      currency={view.currency}
                      amountInput={amountInput}
                      note={note}
                      extra={
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-xs text-muted-foreground">
                            {t('score')} {c.score}
                          </span>
                          {c.reasons.map((r) => (
                            <Badge key={r} variant="outline" className="text-[10px]">
                              {tr(r)}
                            </Badge>
                          ))}
                        </div>
                      }
                    />
                  ))}
                </div>
              )}
            </div>
            <OrderSearch
              transactionId={view.id}
              amount={effective}
              currency={view.currency}
              amountInput={amountInput}
              note={note}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <BankField
                label={t('amount')}
                htmlFor={`amount-${view.id}`}
                hint={t('amountHint', { amount: money(view.unassigned) })}
              >
                <Input
                  id={`amount-${view.id}`}
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  inputMode="decimal"
                  className="w-40"
                  aria-invalid={amountInput.trim() !== '' && amountCents === null}
                />
              </BankField>
              <BankField label={t('note')} htmlFor={`note-${view.id}`}>
                <Input
                  id={`note-${view.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={1000}
                />
              </BankField>
            </div>
          </>
        ) : null}

        <div className="flex flex-wrap items-start gap-2 border-t pt-3">
          {open && credit && view.allocations.length === 0 ? (
            <BankingConfirm
              action={ignoreTransactionAction.bind(null, view.id)}
              title={t('ignoreTitle')}
              description={t('ignoreDescription')}
              confirmLabel={t('ignore')}
              fields={(state) => (
                <BankField
                  label={t('ignoreNote')}
                  htmlFor={`ignore-${view.id}`}
                  error={bankingError(state, 'note')}
                >
                  <Textarea
                    id={`ignore-${view.id}`}
                    name="note"
                    rows={3}
                    maxLength={1000}
                    required
                  />
                </BankField>
              )}
            >
              {t('ignore')}
            </BankingConfirm>
          ) : null}
          {fullyAllocated ? (
            <BankingConfirm
              action={resolveTransactionAction.bind(null, view.id)}
              title={t('resolveTitle')}
              description={t('resolveDescription')}
              confirmLabel={t('resolve')}
              fields={(state) => (
                <BankField
                  label={t('resolveNote')}
                  htmlFor={`resolve-${view.id}`}
                  error={bankingError(state, 'note')}
                >
                  <Textarea
                    id={`resolve-${view.id}`}
                    name="note"
                    rows={3}
                    maxLength={1000}
                    required
                  />
                </BankField>
              )}
            >
              {t('resolve')}
            </BankingConfirm>
          ) : null}
          {credit &&
          !fullyAllocated &&
          view.matchStatus !== 'AUTO_MATCHED' &&
          view.matchStatus !== 'MANUALLY_MATCHED' ? (
            <BankingActionButton
              action={rematchTransactionAction.bind(null, view.id)}
              label={t('rematch')}
              icon="refresh"
            />
          ) : null}
          {showDetailsLink ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/admin/banking/transactions/${view.id}`}>{t('details')}</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function OrderRow({
  transactionId,
  order,
  adjustmentId,
  fallbackNumber,
  amount,
  currency,
  amountInput,
  note,
  extra,
}: {
  transactionId: string;
  order: AssignableOrder | null;
  adjustmentId?: string;
  fallbackNumber: string;
  amount: number;
  currency: string;
  amountInput: string;
  note: string;
  extra?: ReactNode;
}) {
  const t = useTranslations('banking.review');
  const ts = useTranslations('orders.status');
  const format = useFormatter();
  const [state, formAction] = useActionState(
    adjustmentId
      ? assignAdjustmentAction.bind(null, transactionId, order?.id ?? '', adjustmentId)
      : assignTransactionAction.bind(null, transactionId, order?.id ?? ''),
    BANKING_IDLE,
  );
  const [testConfirmed, setTestConfirmed] = useState(false);
  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  if (!order) {
    return <div className="p-3 text-sm text-muted-foreground">{fallbackNumber}</div>;
  }
  const outstanding = order.totalGross - order.amountPaid;
  const payable =
    (adjustmentId ? order.status === 'PAID' : PAYABLE.includes(order.status)) &&
    order.currency === currency;
  const preview = !payable
    ? t('notPayable')
    : adjustmentId
      ? t('previewAdjustment')
      : order.status === 'PAID'
        ? t('previewPaid')
        : amount === outstanding
          ? t('previewExact')
          : amount < outstanding
            ? t('previewPartial', { amount: money(outstanding - amount) })
            : t('previewOver', { amount: money(amount - outstanding) });
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0 space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/admin/orders/${order.id}`} className="font-medium hover:underline">
            {order.orderNumber}
          </Link>
          <Badge variant="secondary">{ts(order.status as Parameters<typeof ts>[0])}</Badge>
          {order.isTest ? <Badge variant="destructive">{t('testBadge')}</Badge> : null}
          {order.paymentReference ? (
            <span className="font-mono text-xs text-muted-foreground">
              {order.paymentReference}
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground">
          {order.name} · {order.email}
        </div>
        <div>
          {t('outstanding')}:{' '}
          <span className="font-medium tabular-nums">{money(Math.max(0, outstanding))}</span>{' '}
          <span className="text-xs text-muted-foreground">
            ({t('paidOf', { paid: money(order.amountPaid), total: money(order.totalGross) })})
          </span>
        </div>
        {extra}
      </div>
      <ActionForm action={formAction} className="flex flex-col items-end gap-1">
        <input type="hidden" name="amount" value={amountInput} />
        <input type="hidden" name="note" value={note} />
        {order.isTest ? (
          <label className="flex max-w-xs items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              name="confirmTest"
              checked={testConfirmed}
              onChange={(e) => setTestConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              {t('testNotice')} {t('testConfirm')}
            </span>
          </label>
        ) : null}
        <SubmitButton size="sm" disabled={!payable || (order.isTest && !testConfirmed)}>
          {t('assign')}
        </SubmitButton>
        <span className="text-xs text-muted-foreground">{preview}</span>
        <BankingFeedback state={state} />
      </ActionForm>
    </div>
  );
}

function OrderSearch({
  transactionId,
  amount,
  currency,
  amountInput,
  note,
}: {
  transactionId: string;
  amount: number;
  currency: string;
  amountInput: string;
  note: string;
}) {
  const t = useTranslations('banking.review');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AssignableOrder[] | null>(null);
  const [pending, startTransition] = useTransition();
  const run = () =>
    startTransition(async () => {
      setResults(await searchAssignableOrders(query));
    });
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{t('searchTitle')}</div>
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
          placeholder={t('searchPlaceholder')}
          maxLength={100}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={run}
          disabled={pending || query.trim().length < 2}
        >
          <Search /> {t('search')}
        </Button>
      </div>
      {results !== null ? (
        results.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noResults')}</p>
        ) : (
          <div className="divide-y rounded-md border">
            {results.map((order) => (
              <OrderRow
                key={order.id}
                transactionId={transactionId}
                order={order}
                fallbackNumber={order.orderNumber}
                amount={amount}
                currency={currency}
                amountInput={amountInput}
                note={note}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
