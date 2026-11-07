import { getTranslations } from 'next-intl/server';
import { BankAccountForm } from '@/components/admin/banking/account-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { saveBankAccountAction } from '@/server/admin/banking-actions';
import { listBankAccounts } from '@/server/admin/banking-queries';

export default async function NewBankAccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const [t, tc, existing] = await Promise.all([
    getTranslations('banking.accounts'),
    getTranslations('common.actions'),
    listBankAccounts(),
  ]);
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('newTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <BankAccountForm
          action={saveBankAccountAction.bind(null, null)}
          submitLabel={tc('create')}
          initial={{
            name: '',
            accountHolder: '',
            iban: '',
            bic: null,
            bankName: null,
            currency: 'EUR',
            isDefaultForBankTransfer: existing.length === 0,
            isActive: true,
          }}
        />
      </CardContent>
    </Card>
  );
}
