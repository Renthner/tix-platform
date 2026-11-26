import { SUPPORTED_BANK_ADAPTERS, formatIban } from '@tix/shared';
import { Cable } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { BankAccountForm } from '@/components/admin/banking/account-form';
import { BankingActionsMenu } from '@/components/admin/banking/banking-actions-menu';
import { BankingPage } from '@/components/admin/banking/banking-page';
import { SyncStatusBadge } from '@/components/admin/banking/banking-ui';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { EmptyState } from '@/components/admin/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
    <BankingPage
      title={
        <span className="flex flex-wrap items-center gap-2">
          {account.name}
          {account.isDefaultForBankTransfer ? <Badge>{t('accounts.default')}</Badge> : null}
          {account.isActive ? null : <Badge variant="outline">{t('accounts.inactive')}</Badge>}
        </span>
      }
      description={[formatIban(account.iban), account.bankName].filter(Boolean).join(' · ')}
      trail={[{ label: t('accounts.title'), href: '/admin/banking/accounts' }]}
      actions={
        <BankingActionsMenu
          links={[
            {
              key: 'upload',
              label: t('connection.actions.uploadFiles'),
              href: `/admin/banking/imports?account=${account.id}`,
            },
          ]}
          dialogs={[
            {
              key: 'delete',
              label: t('accounts.delete'),
              action: deleteBankAccountAction.bind(null, account.id),
              title: t('accounts.deleteTitle'),
              description: t('accounts.deleteDescription'),
              confirmLabel: tc('delete'),
              destructive: true,
            },
          ]}
        />
      }
    >
      <DetailLayout
        className="p-0"
        aside={
          <DetailSection
            title={t('accounts.connectionsTitle')}
            description={t('accounts.connectionsDescription')}
          >
            <div className="space-y-4">
              {connections.length === 0 ? (
                <EmptyState size="sm" icon={Cable} title={t('accounts.noConnections')} />
              ) : (
                <ul className="divide-y rounded-md border">
                  {connections.map((c) => (
                    <li key={c.id} className="space-y-1 p-3">
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
                      <div className="flex flex-wrap items-center gap-2">
                        {c.isActive ? null : (
                          <Badge variant="outline">{t('accounts.inactive')}</Badge>
                        )}
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
                <div className="grid gap-2">
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
            </div>
          </DetailSection>
        }
      >
        <DetailSection title={t('accounts.detailsTitle')}>
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
        </DetailSection>
      </DetailLayout>
    </BankingPage>
  );
}
