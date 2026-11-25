'use client';

import type { BulkOrderOutcome, OrderListRow } from '@tix/core';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { OrderStatusBadge } from '@/components/admin/order-badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { bulkOrderAction } from '@/server/admin/orders-bulk';

type Action = 'remind' | 'keepReservedOn' | 'keepReservedOff' | 'resendTickets' | 'cancelUnpaid';
type ConfirmedAction = 'remind' | 'resendTickets' | 'cancelUnpaid';
const CONFIRMED: readonly Action[] = ['remind', 'resendTickets', 'cancelUnpaid'];
const RESULT_CODES = [
  'UNCHANGED',
  'RECENTLY_REMINDED',
  'REMINDER_NOT_APPLICABLE',
  'ORDER_NOT_OPEN',
  'ORDER_NOT_PAID',
  'NO_TICKETS',
  'ORDER_NOT_CANCELLABLE',
  'ORDER_NOT_FOUND',
  'INTERNAL_ERROR',
] as const;
const isConfirmed = (a: Action): a is ConfirmedAction => CONFIRMED.includes(a);

export interface SortHeader {
  href: string;
  /** `asc` / `desc` when this is the active sort column. */
  active: 'asc' | 'desc' | null;
}

/** Order list table with sortable headers, row selection and bulk actions. */
export function OrdersTable({
  rows,
  sortHeaders,
  now,
}: {
  rows: OrderListRow[];
  /** Sort links by column key (`number`, `date`, …); columns without an entry are not sortable. */
  sortHeaders: Record<string, SortHeader>;
  /** Render time (ms) for the overdue marker, so the output is stable between server and client. */
  now: number;
}) {
  const t = useTranslations('orders.admin');
  const tBulk = useTranslations('orders.admin.bulk');
  const tChannel = useTranslations('orders.channel');
  const tMethod = useTranslations('orders.method');
  const format = useFormatter();
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmedAction | null>(null);
  const [results, setResults] = useState<{ action: Action; items: BulkOrderOutcome[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const run = (action: Action) => {
    setError(null);
    startTransition(async () => {
      const state = await bulkOrderAction(action, [...selected]);
      if (state.status === 'done') {
        setResults({ action, items: state.results });
        setSelected(new Set());
        router.refresh();
      } else if (state.status === 'error') {
        setResults(null);
        setError(state.code);
      }
    });
  };
  const request = (action: Action) => (isConfirmed(action) ? setConfirm(action) : run(action));

  const header = (key: string, label: string, className?: string) => {
    const sort = sortHeaders[key];
    if (!sort) return <TableHead className={className}>{label}</TableHead>;
    const Icon = sort.active === 'asc' ? ArrowUp : sort.active === 'desc' ? ArrowDown : ArrowUpDown;
    return (
      <TableHead
        className={className}
        aria-sort={
          sort.active === 'asc' ? 'ascending' : sort.active === 'desc' ? 'descending' : undefined
        }
      >
        <Link
          href={sort.href}
          className="inline-flex items-center gap-1 hover:underline"
          data-testid={`sort-${key}`}
        >
          {label}
          <Icon className="size-3.5 opacity-70" aria-hidden />
        </Link>
      </TableHead>
    );
  };

  const codeLabel = (code?: string) => {
    const known = RESULT_CODES.find((c) => c === code);
    return known ? tBulk(`codes.${known}`) : (code ?? '');
  };
  const notDone = results?.items.filter((r) => r.outcome !== 'done') ?? [];

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2 text-sm"
          data-testid="bulk-bar"
        >
          <span className="px-1 font-medium">{tBulk('selected', { count: selected.size })}</span>
          {(['remind', 'keepReservedOn', 'keepReservedOff', 'resendTickets'] as const).map((a) => (
            <Button
              key={a}
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => request(a)}
            >
              {tBulk(`actions.${a}`)}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => request('cancelUnpaid')}
          >
            {tBulk('actions.cancelUnpaid')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {tBulk('clear')}
          </Button>
        </div>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{tBulk('failed')}</AlertDescription>
        </Alert>
      )}
      {results && (
        <Alert role="status" data-testid="bulk-result">
          <AlertDescription>
            <p className="font-medium">
              {tBulk('summary', {
                action: tBulk(`actions.${results.action}`),
                done: results.items.length - notDone.length,
                other: notDone.length,
              })}
            </p>
            {notDone.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {notDone.map((r) => (
                  <li key={r.orderId}>
                    {r.orderNumber || r.orderId}: {codeLabel(r.code)}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                aria-label={tBulk('selectAll')}
                checked={allSelected}
                onCheckedChange={(on) =>
                  setSelected(on === true ? new Set(rows.map((r) => r.id)) : new Set())
                }
              />
            </TableHead>
            {header('number', t('columns.number'))}
            {header('date', t('columns.date'))}
            {header('customer', t('columns.customer'))}
            {header('method', t('columns.method'))}
            {header('tickets', t('columns.tickets'), 'text-right')}
            {header('total', t('columns.total'), 'text-right')}
            {header('status', t('columns.status'))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} data-state={selected.has(row.id) ? 'selected' : undefined}>
              <TableCell>
                <Checkbox
                  aria-label={tBulk('selectOrder', { number: row.orderNumber })}
                  checked={selected.has(row.id)}
                  onCheckedChange={(on) => toggle(row.id, on === true)}
                />
              </TableCell>
              <TableCell className="font-medium whitespace-nowrap">
                <Link href={`/admin/orders/${row.id}`} className="hover:underline">
                  {row.orderNumber}
                </Link>
                {row.paymentReference && (
                  <div className="font-mono text-xs text-muted-foreground">
                    {row.paymentReference}
                  </div>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {format.dateTime(row.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
              </TableCell>
              <TableCell>
                <div>
                  {row.firstName} {row.lastName}
                </div>
                <div className="text-xs text-muted-foreground">{row.email}</div>
                {row.isTest && (
                  <Badge variant="outline" className="mt-1 mr-1 border-warning-border text-warning">
                    {t('testBadge')}
                  </Badge>
                )}
                {row.testHidden && (
                  <Badge variant="outline" className="mt-1 mr-1">
                    {t('testHidden')}
                  </Badge>
                )}
                {row.channel !== 'ONLINE' && (
                  <Badge variant="outline" className="mt-1">
                    {tChannel(row.channel)}
                  </Badge>
                )}
              </TableCell>
              <TableCell>{tMethod(row.paymentMethod)}</TableCell>
              <TableCell className="text-right tabular-nums">{row.ticketCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {format.number(row.totalGross / 100, { style: 'currency', currency: row.currency })}
              </TableCell>
              <TableCell>
                <OrderStatusBadge status={row.status} />
                {row.keepReserved && (
                  <div className="text-xs text-muted-foreground">{t('keptReserved')}</div>
                )}
                {row.status === 'AWAITING_PAYMENT' &&
                  row.paymentDueAt &&
                  row.paymentDueAt.getTime() < now && (
                    <div className="text-xs text-destructive">{t('overdue')}</div>
                  )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? tBulk(`confirm.${confirm}.title`, { count: selected.size }) : undefined}
        description={confirm ? tBulk(`confirm.${confirm}.description`) : undefined}
        confirmLabel={confirm ? tBulk(`actions.${confirm}`) : undefined}
        variant={confirm === 'cancelUnpaid' ? 'destructive' : 'default'}
        onConfirm={() => confirm && run(confirm)}
      />
    </div>
  );
}
