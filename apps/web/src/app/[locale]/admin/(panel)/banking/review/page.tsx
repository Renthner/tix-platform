import { BANK_TX_REVIEW_REASONS, buildQuery, type BankTxReviewReason } from '@tix/shared';
import { CheckCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { BankingPage } from '@/components/admin/banking/banking-page';
import { ReviewCase } from '@/components/admin/banking/review-case';
import { EmptyState } from '@/components/admin/empty-state';
import { FilterSelect } from '@/components/admin/filter-select';
import { ListToolbar, type ActiveFilterChip } from '@/components/admin/list-toolbar';
import { StatusTabs } from '@/components/admin/status-tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import {
  listBankAccounts,
  listReviewCases,
  toReviewCaseView,
} from '@/server/admin/banking-queries';

const PAGE_SIZE = 20;
const UUID = /^[0-9a-f-]{36}$/i;

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const sp = await searchParams;
  const reason = (BANK_TX_REVIEW_REASONS as readonly string[]).includes(sp.reason ?? '')
    ? (sp.reason as BankTxReviewReason)
    : undefined;
  const accountId = UUID.test(sp.account ?? '') ? sp.account : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const [t, tl, accounts, result] = await Promise.all([
    getTranslations('banking'),
    getTranslations('admin.list'),
    listBankAccounts(),
    listReviewCases({ reason, accountId }, page, PAGE_SIZE),
  ]);

  const base = '/admin/banking/review';
  const listParams = { reason, account: accountId };
  const totalAll = Object.values(result.reasons).reduce((s, n) => s + n, 0);
  // Reason tabs: only reasons with open cases (plus the selected one), each with its count.
  const tabs = [
    {
      key: 'all',
      label: t('review.allReasons'),
      href: buildQuery(base, listParams, { reason: undefined }),
      active: !reason,
      count: totalAll,
      'data-testid': 'review-reason-all',
    },
    ...BANK_TX_REVIEW_REASONS.filter((r) => (result.reasons[r] ?? 0) > 0 || r === reason).map(
      (r) => ({
        key: r,
        label: t(`reason.${r}`),
        href: buildQuery(base, listParams, { reason: r }),
        active: reason === r,
        count: result.reasons[r] ?? 0,
        'data-testid': `review-reason-${r}`,
      }),
    ),
  ];

  const accountName = accounts.find((a) => a.id === accountId)?.name;
  const chips: ActiveFilterChip[] = accountId
    ? [
        {
          key: 'account',
          label: `${t('transactions.filters.account')}: ${accountName ?? accountId}`,
          removeHref: buildQuery(base, listParams, { account: undefined }),
        },
      ]
    : [];
  const resetHref = chips.length > 0 ? buildQuery(base, { reason }) : null;

  return (
    <BankingPage title={t('review.title')} description={t('review.description')}>
      <StatusTabs label={t('review.reasonsLabel')} tabs={tabs} />
      {accounts.length > 1 || accountId ? (
        <ListToolbar
          filters={
            <FilterSelect
              name="account"
              value={accountId}
              ariaLabel={t('transactions.filters.account')}
              allLabel={t('review.allAccounts')}
              searchable={false}
              options={accounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          }
          hidden={{ reason }}
          resetHref={resetHref}
          chips={chips}
        />
      ) : null}
      {result.cases.length === 0 ? (
        <Card>
          <CardContent>
            {reason || accountId ? (
              <EmptyState
                icon={CheckCheck}
                title={t('review.emptyFiltered')}
                description={tl('emptyFiltered')}
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href={base}>{tl('reset')}</Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={CheckCheck}
                tone="success"
                title={t('review.empty')}
                data-testid="review-empty"
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {result.cases.map((rc) => (
            <ReviewCase key={rc.tx.id} view={toReviewCaseView(rc)} />
          ))}
        </div>
      )}
      <AdminPagination
        pathname={base}
        params={listParams}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total}
        summary={t('review.count', { count: result.total })}
      />
    </BankingPage>
  );
}
