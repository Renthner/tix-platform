import { buildQuery, type BankTxMatchStatus } from '@tix/shared';
import { Download, Inbox } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { HoldBadge, MatchStatusBadge, ReasonBadge } from '@/components/admin/banking/banking-ui';
import { BankingPage } from '@/components/admin/banking/banking-page';
import { EmptyState } from '@/components/admin/empty-state';
import { FilterSelect } from '@/components/admin/filter-select';
import {
  ListToolbar,
  MoreFilterField,
  type ActiveFilterChip,
} from '@/components/admin/list-toolbar';
import { StatusTabs } from '@/components/admin/status-tabs';
import { bankTxHold } from '@/lib/banking-hold';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
/** Status tabs (one status at a time), in workflow order. */
const STATUS_TABS: readonly BankTxMatchStatus[] = [
  'NEEDS_REVIEW',
  'UNMATCHED',
  'AUTO_MATCHED',
  'MANUALLY_MATCHED',
  'IGNORED',
];

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
  const [t, tl, format, locale, accounts, result] = await Promise.all([
    getTranslations('banking'),
    getTranslations('admin.list'),
    getFormatter(),
    getLocale(),
    listBankAccounts(),
    listTransactions(filters, page, PAGE_SIZE),
  ]);
  const orderNumbers = await allocatedOrderNumbers(result.rows.map((r) => r.tx.id));

  const base = '/admin/banking/transactions';
  const listParams = {
    status: filters.status,
    reason: filters.reason,
    account: filters.accountId,
    from: filters.from,
    to: filters.to,
    q: filters.q,
    direction: filters.direction,
  };
  const exportHref = buildQuery('/api/admin/banking/transactions/export', {
    ...listParams,
    locale,
  });

  const tabs = [
    {
      key: 'all',
      label: tl('all'),
      href: buildQuery(base, listParams, { status: undefined }),
      active: !filters.status,
      'data-testid': 'transactions-status-all',
    },
    ...STATUS_TABS.map((s) => ({
      key: s,
      label: t(`status.${s}`),
      href: buildQuery(base, listParams, { status: s }),
      active: filters.status === s,
      'data-testid': `transactions-status-${s}`,
    })),
  ];

  const without = (overrides: Record<string, string | undefined>) =>
    buildQuery(base, listParams, overrides);
  const directionLabel = (d: 'in' | 'out') =>
    d === 'in' ? t('transactions.incoming') : t('transactions.outgoing');
  const chips: ActiveFilterChip[] = [];
  if (filters.q) {
    chips.push({
      key: 'q',
      label: tl('searchChip', { value: filters.q }),
      removeHref: without({ q: undefined }),
    });
  }
  if (filters.direction) {
    chips.push({
      key: 'direction',
      label: `${t('transactions.filters.direction')}: ${directionLabel(filters.direction)}`,
      removeHref: without({ direction: undefined }),
    });
  }
  if (filters.accountId) {
    const name = accounts.find((a) => a.id === filters.accountId)?.name ?? filters.accountId;
    chips.push({
      key: 'account',
      label: `${t('transactions.filters.account')}: ${name}`,
      removeHref: without({ account: undefined }),
    });
  }
  if (filters.reason) {
    chips.push({
      key: 'reason',
      label: `${t('transactions.fields.reason')}: ${t(`reason.${filters.reason}`)}`,
      removeHref: without({ reason: undefined }),
    });
  }
  if (filters.from) {
    chips.push({
      key: 'from',
      label: `${t('transactions.from')}: ${filters.from}`,
      removeHref: without({ from: undefined }),
    });
  }
  if (filters.to) {
    chips.push({
      key: 'to',
      label: `${t('transactions.to')}: ${filters.to}`,
      removeHref: without({ to: undefined }),
    });
  }
  // Reset keeps the status tab.
  const resetHref = chips.length > 0 ? buildQuery(base, { status: filters.status }) : null;
  const moreActiveCount = [filters.from, filters.to].filter(Boolean).length;
  const dateClass =
    'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm font-normal text-foreground';

  return (
    <BankingPage
      title={t('transactions.title')}
      description={t('transactions.description')}
      actions={
        <Button asChild variant="outline">
          <a href={exportHref} download data-testid="transactions-export">
            <Download /> {t('transactions.export')}
          </a>
        </Button>
      }
    >
      <StatusTabs label={t('transactions.statusTabs')} tabs={tabs} />
      <ListToolbar
        data-testid="transactions-toolbar"
        search={{ value: filters.q, placeholder: t('transactions.searchPlaceholder') }}
        filters={
          <>
            <FilterSelect
              name="direction"
              value={filters.direction}
              ariaLabel={t('transactions.filters.direction')}
              allLabel={t('transactions.allDirections')}
              searchable={false}
              options={[
                { value: 'in', label: t('transactions.incoming') },
                { value: 'out', label: t('transactions.outgoing') },
              ]}
            />
            {accounts.length > 1 ? (
              <FilterSelect
                name="account"
                value={filters.accountId}
                ariaLabel={t('transactions.filters.account')}
                allLabel={t('review.allAccounts')}
                searchable={false}
                options={accounts.map((a) => ({ value: a.id, label: a.name }))}
              />
            ) : null}
          </>
        }
        moreActiveCount={moreActiveCount}
        moreFilters={
          <div className="grid grid-cols-2 gap-2">
            <MoreFilterField label={t('transactions.from')}>
              <input
                type="date"
                name="from"
                defaultValue={filters.from ?? ''}
                className={dateClass}
              />
            </MoreFilterField>
            <MoreFilterField label={t('transactions.to')}>
              <input type="date" name="to" defaultValue={filters.to ?? ''} className={dateClass} />
            </MoreFilterField>
          </div>
        }
        hidden={{
          status: filters.status,
          reason: filters.reason,
          // A single account has no select; keep a filter that came in through a link.
          account: accounts.length > 1 ? undefined : filters.accountId,
        }}
        resetHref={resetHref}
        chips={chips}
      />
      <Card>
        <CardContent>
          {result.rows.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={t('transactions.empty')}
              description={resetHref || filters.status ? tl('emptyFiltered') : undefined}
              action={
                resetHref ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={resetHref}>{tl('reset')}</Link>
                  </Button>
                ) : undefined
              }
            />
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
                {result.rows.map(({ tx, accountName }) => {
                  const hold = bankTxHold(tx.rawData);
                  return (
                    <TableRow key={tx.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link
                          href={`/admin/banking/transactions/${tx.id}`}
                          className="font-medium hover:underline"
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
                        className={`text-right whitespace-nowrap tabular-nums ${tx.amount > 0 ? 'text-success' : ''}`}
                      >
                        {format.number(tx.amount / 100, {
                          style: 'currency',
                          currency: tx.currency,
                          signDisplay: 'exceptZero',
                        })}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {hold ? (
                            <HoldBadge hold={hold} />
                          ) : (
                            <MatchStatusBadge status={tx.matchStatus} />
                          )}
                          {tx.matchStatus === 'NEEDS_REVIEW' && tx.reviewReason ? (
                            <ReasonBadge reason={tx.reviewReason} />
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {(orderNumbers.get(tx.id) ?? []).join(', ') || '–'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <AdminPagination
        pathname={base}
        params={listParams}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total}
        summary={t('transactions.total', { count: result.total })}
      />
    </BankingPage>
  );
}
