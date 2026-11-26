import { MIN_POLL_INTERVAL } from '@tix/core';
import {
  SUPPORTED_BANK_ADAPTERS,
  csvProfileSchema,
  germanAccountFromIban,
  type SupportedBankAdapter,
} from '@tix/shared';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  ConnectionForm,
  type ConnectionFormValues,
} from '@/components/admin/banking/connection-form';
import { BankingPage } from '@/components/admin/banking/banking-page';
import { Card, CardContent } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { saveBankConnectionAction } from '@/server/admin/banking-actions';
import { getBankAccount } from '@/server/admin/banking-queries';

/** Suggested polling: FinTS hourly, mailbox every 15 min, PSD2 4× a day. */
const DEFAULT_POLL_SECONDS: Record<SupportedBankAdapter, number | null> = {
  FINTS: 3600,
  PSD2_FINAPI: 21_600,
  IMAP: 900,
  FILE_IMPORT: null,
};

function defaults(adapter: SupportedBankAdapter, iban: string): ConnectionFormValues['config'] {
  const csvProfile = csvProfileSchema.parse({});
  switch (adapter) {
    case 'FINTS':
      return {
        adapter,
        serverUrl: '',
        bankCode: germanAccountFromIban(iban)?.bankCode ?? '',
        userId: '',
        productId: '',
        productVersion: '1.0',
        preferCamt: true,
        lookbackDays: 30,
      };
    case 'PSD2_FINAPI':
      return {
        adapter,
        environment: 'sandbox',
        clientId: '',
        backgroundUpdate: true,
        lookbackDays: 30,
      };
    case 'FILE_IMPORT':
      return { adapter, formatHint: 'AUTO', csvProfile };
    case 'IMAP':
      return {
        adapter,
        host: '',
        port: 993,
        secure: true,
        username: '',
        mailbox: 'INBOX',
        senderAllowlist: [], // empty until the admin enters senders (required by the form)
        attachmentFormats: ['CAMT052', 'CAMT053', 'MT940', 'CSV'],
        lookbackDays: 14,
        csvProfile,
      };
  }
}

export default async function NewConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ adapter?: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const { id } = await params;
  const { adapter: raw } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const adapter = (SUPPORTED_BANK_ADAPTERS as readonly string[]).includes(raw ?? '')
    ? (raw as SupportedBankAdapter)
    : null;
  if (!adapter) notFound();
  const [t, tc, data] = await Promise.all([
    getTranslations('banking'),
    getTranslations('common.actions'),
    getBankAccount(id),
  ]);
  if (!data) notFound();
  const adapterName = t(`adapter.${adapter}`);
  return (
    <BankingPage
      title={t('connection.newTitle', { adapter: adapterName })}
      description={t(`adapterHint.${adapter}`)}
      trail={[
        { label: t('accounts.title'), href: '/admin/banking/accounts' },
        { label: data.account.name, href: `/admin/banking/accounts/${id}` },
      ]}
    >
      <Card className="max-w-4xl">
        <CardContent>
          <ConnectionForm
            adapter={adapter}
            action={saveBankConnectionAction.bind(null, id, null, adapter)}
            minPollMinutes={Math.ceil(MIN_POLL_INTERVAL[adapter] / 60)}
            submitLabel={tc('create')}
            initial={{
              name: `${data.account.name} – ${adapterName}`.slice(0, 120),
              isActive: true,
              pollIntervalSeconds: DEFAULT_POLL_SECONDS[adapter],
              config: defaults(adapter, data.account.iban),
              hasSecrets: false,
            }}
          />
        </CardContent>
      </Card>
    </BankingPage>
  );
}
