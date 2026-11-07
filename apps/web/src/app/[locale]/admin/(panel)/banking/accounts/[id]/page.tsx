import { SUPPORTED_BANK_ADAPTERS } from '@tix/shared';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { BankAccountForm, BankingConfirm } from '@/components/admin/banking/account-form';
import { SyncStatusBadge } from '@/components/admin/banking/banking-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { deleteBankAccountAction, saveBankAccountAction } from '@/server/admin/banking-actions';
import { getBankAccount } from '@/server/admin/banking-queries';

export default async function BankAccountPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t, tc, format, data] = await Promise.all([
    getTranslations('banking'),
    getTranslations('common.actions'),
    getFormatter(),
    getBankAccount(id),
  ]);
  if (!data) notFound();
  const { account, connections } = data;
  return (
    <>
      <Card className="max-w-3xl">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <CardTitle>{account.name}</CardTitle>
          <BankingConfirm
            action={deleteBankAccountAction.bind(null, account.id)}
            title={t('accounts.deleteTitle')}
            description={t('accounts.deleteDescription')}
            confirmLabel={tc('delete')}
          >
            {t('accounts.delete')}
          </BankingConfirm>
        </CardHeader>
        <CardContent>
          <BankAccountForm
            action={saveBankAccountAction.bind(null, account.id)}
            submitLabel={tc('save')}
            initial={{
              name: account.name,
              accountHolder: account.accountHolder,
              iban: account.iban,
              bic: account.bic,
              bankName: account.bankName,
              currency: account.currency,
              isDefaultForBankTransfer: account.isDefaultForBankTransfer,
              isActive: account.isActive,
            }}
          />
        </CardContent>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t('accounts.connectionsTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('accounts.connectionsDescription')}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('accounts.noConnections')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {connections.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div>
                    <Link
                      href={`/admin/banking/connections/${c.id}`}
                      className="font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {t(`adapter.${c.adapter}`)}
                      {c.lastSyncAt ? ` · ${format.relativeTime(c.lastSyncAt)}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {c.isActive ? null : <Badge variant="outline">{t('accounts.inactive')}</Badge>}
                    {c.adapter === 'FILE_IMPORT' ? null : (
                      <SyncStatusBadge status={c.lastSyncStatus} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2">
            <div className="text-sm font-medium">{t('accounts.addConnection')}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {SUPPORTED_BANK_ADAPTERS.map((adapter) => (
                <Button
                  key={adapter}
                  asChild
                  variant="outline"
                  className="h-auto flex-col items-start gap-1 whitespace-normal p-3 text-left"
                >
                  <Link
                    href={`/admin/banking/accounts/${account.id}/connections/new?adapter=${adapter}`}
                  >
                    <span className="font-medium">{t(`adapter.${adapter}`)}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t(`adapterHint.${adapter}`)}
                    </span>
                  </Link>
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
