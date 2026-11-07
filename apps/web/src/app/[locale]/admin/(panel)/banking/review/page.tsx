import { BANK_TX_REVIEW_REASONS, type BankTxReviewReason } from '@tix/shared';
import { getTranslations } from 'next-intl/server';
import { NativeSelect } from '@/components/admin/form-controls';
import { ReviewCase } from '@/components/admin/banking/review-case';
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
  const [t, accounts, result] = await Promise.all([
    getTranslations('banking'),
    listBankAccounts(),
    listReviewCases({ reason, accountId }, page, PAGE_SIZE),
  ]);
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const href = (p: number) => {
    const usp = new URLSearchParams(
      Object.entries({ reason, account: accountId, page: p > 1 ? String(p) : undefined }).filter(
        (e): e is [string, string] => Boolean(e[1]),
      ),
    );
    const s = usp.toString();
    return s ? `/admin/banking/review?${s}` : '/admin/banking/review';
  };
  return (
    <>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('review.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('review.description')}</p>
      </div>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <NativeSelect
          name="reason"
          defaultValue={reason ?? ''}
          className="w-auto"
          aria-label={t('review.allReasons')}
        >
          <option value="">
            {t('review.allReasons')} ({Object.values(result.reasons).reduce((s, n) => s + n, 0)})
          </option>
          {BANK_TX_REVIEW_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`reason.${r}`)} ({result.reasons[r] ?? 0})
            </option>
          ))}
        </NativeSelect>
        {accounts.length > 1 ? (
          <NativeSelect
            name="account"
            defaultValue={accountId ?? ''}
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
        <Button type="submit" variant="secondary">
          {t('review.filter')}
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {t('review.count', { count: result.total })}
        </span>
      </form>
      {result.cases.length === 0 ? (
        <Card>
          <CardContent>
            <p className="py-6 text-center text-sm text-muted-foreground">{t('review.empty')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {result.cases.map((rc) => (
            <ReviewCase key={rc.tx.id} view={toReviewCaseView(rc)} />
          ))}
        </div>
      )}
      {pages > 1 ? (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={href(page - 1)}>{t('transactions.previous')}</Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">{t('transactions.page', { page, pages })}</span>
          {page < pages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={href(page + 1)}>{t('transactions.next')}</Link>
            </Button>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </>
  );
}
