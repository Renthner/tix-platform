import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { WalletDesignForm } from '@/components/admin/wallet-settings-forms';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getEventWithVenue } from '@/server/admin/queries';
import { resetWalletDesignAction, saveWalletDesignAction } from '@/server/admin/wallet';
import { loadWalletDesignValues } from '@/server/admin/wallet-design';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('wallet') };
}

export default async function EventWalletPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const t = await getTranslations('admin.wallet.design');
  const { values, isOverride } = await loadWalletDesignValues(row.event.id);
  return (
    <div className="max-w-5xl space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('eventTitle')}</CardTitle>
          <CardDescription>{t('eventDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <WalletDesignForm
            action={saveWalletDesignAction.bind(null, row.event.id)}
            resetAction={resetWalletDesignAction.bind(null, row.event.id)}
            initial={values}
            isOverride={isOverride}
            inheritNote
          />
        </CardContent>
      </Card>
    </div>
  );
}
