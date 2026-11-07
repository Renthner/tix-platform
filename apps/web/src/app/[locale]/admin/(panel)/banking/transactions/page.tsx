import { BANK_TX_MATCH_STATUSES } from '@tix/shared';
import { Download, Search } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { MatchStatusBadge, ReasonBadge } from '@/components/admin/banking/banking-ui';
import { NativeSelect } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import {
  allocatedOrderNumbers,
  listBankAccounts,
  listTransactions,
  parseTransactionFilters,
} from '@/server/admin/banking-queries';

const PAGE_SIZE = 50;

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const sp = await searchParams;
  const filters = parseTransactionFilters(sp);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const [t, format, locale, accounts, result] = await Promise.all([
    getTranslations('banking'),
    getFormatter(),
    getLocale(),
    listBankAccounts(),
    listTransactions(filters, page, PAGE_SIZE),
  ]);
  const orderNumbers = await allocatedOrderNumbers(result.rows.map((r) => r.tx.id));
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const query = (overrides: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {
      status: filters.status,
      reason: filters.reason,
      account: filters.accountId,
      from: filters.from,
      to: filters.to,
      q: filters.q,
      direction: filters.direction,
      ...overrides,
    };
    return new URLSearchParams(
      Object.entries(merged).filter((e): e is [string, string] => Boolean(e[1])),
    ).toString();
  };
  const pageHref = (p: number) => {
    const s = query({ page: p > 1 ? String(p) : undefined });
    return s ? `/admin/banking/transactions?${s}` : '/admin/banking/transactions';
  };
  const exportHref = `/api/admin/banking/transactions/export?${query({ locale })}`;

  return (
    <>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder={t('transactions.searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <NativeSelect
          name="status"
          defaultValue={filters.status ?? ''}
          className="w-auto"
          aria-label={t('transactions.allStatuses')}
        >
          <option value="">{t('transactions.allStatuses')}</option>
          {BANK_TX_MATCH_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="direction"
          defaultValue={filters.direction ?? ''}
          className="w-auto"
          aria-label={t('transactions.allDirections')}
        >
          <option value="">{t('transactions.allDirections')}</option>
          <option value="in">{t('transactions.incoming')}</option>
          <option value="out">{t('transactions.outgoing')}</option>
        </NativeSelect>
        {accounts.length > 1 ? (
          <NativeSelect
            name="account"
            defaultValue={filters.accountId ?? ''}
            className="w-auto"
            aria-label={t('review.allAccounts')}
          >
            <option value="">{t('review.allAccounts')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <label className="text-sm">
          <span className="sr-only">{t('transactions.from')}</span>
          <Input
            type="date"
            name="from"
            defaultValue={filters.from ?? ''}
            aria-label={t('transactions.from')}
            className="w-40"
          />
        </label>
        <label className="text-sm">
          <span className="sr-only">{t('transactions.to')}</span>
          <Input
            type="date"
            name="to"
            defaultValue={filters.to ?? ''}
            aria-label={t('transactions.to')}
            className="w-40"
          />
        </label>
        <Button type="submit" variant="secondary">
          {t('transactions.filter')}
        </Button>
        <Button asChild variant="outline">
          <a href={exportHref}>
            <Download /> {t('transactions.export')}
          </a>
        </Button>
      </form>
      <Card>
        <CardContent>
          {result.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('transactions.empty')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('transactions.columns.date')}</TableHead>
                  <TableHead>{t('transactions.columns.counterparty')}</TableHead>
                  <TableHead>{t('transactions.columns.text')}</TableHead>
                  <TableHead className="text-right">{t('transactions.columns.amount')}</TableHead>
                  <TableHead>{t('transactions.columns.status')}</TableHead>
                  <TableHead>{t('transactions.columns.orders')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map(({ tx, accountName }) => (
                  <TableRow key={tx.id}>
                    <TableCell className="whitespace-nowrap">
                      <Link
                        href={`/admin/banking/transactions/${tx.id}`}
                        className="hover:underline"
                      >
                        {format.dateTime(new Date(`${tx.bookingDate}T12:00:00Z`), {
                          dateStyle: 'medium',
                        })}
                      </Link>
                      {accounts.length > 1 ? (
                        <div className="text-xs text-muted-foreground">{accountName}</div>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className="max-w-48 truncate"
                      title={tx.counterpartyName ?? undefined}
                    >
                      {tx.counterpartyName ?? '–'}
                    </TableCell>
                    <TableCell
                      className="max-w-80 truncate text-xs"
                      title={tx.remittanceInformation ?? undefined}
                    >
                      {tx.remittanceInformation ?? '–'}
                    </TableCell>
                    <TableCell
                      className={`text-right whitespace-nowrap tabular-nums ${tx.amount > 0 ? 'text-emerald-700 dark:text-emerald-400' : ''}`}
                    >
                      {format.number(tx.amount / 100, {
                        style: 'currency',
                        currency: tx.currency,
                        signDisplay: 'exceptZero',
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <MatchStatusBadge status={tx.matchStatus} />
                        {tx.matchStatus === 'NEEDS_REVIEW' && tx.reviewReason ? (
                          <ReasonBadge reason={tx.reviewReason} />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {(orderNumbers.get(tx.id) ?? []).join(', ') || '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('transactions.total', { count: result.total })}
        </span>
        {pages > 1 ? (
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(page - 1)}>{t('transactions.previous')}</Link>
              </Button>
            ) : null}
            <span className="text-muted-foreground">{t('transactions.page', { page, pages })}</span>
            {page < pages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(page + 1)}>{t('transactions.next')}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
