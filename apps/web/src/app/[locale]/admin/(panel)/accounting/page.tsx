import { getSetting, localDateOf, formatLocalDate, rangePresets } from '@tix/core';
import { getLocale, getTranslations } from 'next-intl/server';
import { AccountingExportForm, AccountingSettingsForm } from '@/components/admin/accounting-forms';
import { PageHeader } from '@/components/admin/form-controls';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { saveAccountingSettingsAction } from '@/server/admin/accounting';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('accounting');
  return { title: t('title') };
}

export default async function AccountingPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const core = getCore();
  const [t, locale, general, settings] = await Promise.all([
    getTranslations('accounting'),
    getLocale(),
    getSetting(core, 'general'),
    getSetting(core, 'accounting'),
  ]);
  const today = formatLocalDate(localDateOf(new Date(), general.defaultTimeZone));
  const presets = rangePresets(today, settings.fiscalYearStart);

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('export.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('export.description')}</p>
          </CardHeader>
          <CardContent>
            <AccountingExportForm presets={presets} locale={locale} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('settings.description')}</p>
          </CardHeader>
          <CardContent>
            <AccountingSettingsForm
              action={saveAccountingSettingsAction}
              initial={{
                chart: settings.chart,
                consultantNumber: settings.consultantNumber,
                clientNumber: settings.clientNumber,
                fiscalYearStart: settings.fiscalYearStart,
                accountLength: settings.accountLength,
                taxAccounts: settings.taxAccounts,
                debtorAccount: settings.debtorAccount,
                bankAccount: settings.bankAccount,
                paypalAccount: settings.paypalAccount,
                cashAccount: settings.cashAccount,
                cardAccount: settings.cardAccount,
                writeOffAccount: settings.writeOffAccount,
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
