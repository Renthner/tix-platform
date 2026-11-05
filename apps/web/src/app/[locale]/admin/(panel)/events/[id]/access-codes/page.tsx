import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AccessCodeCreateForm, AccessCodeTable } from '@/components/admin/access-codes';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { createAccessCodesAction, setAccessCodeActiveAction } from '@/server/admin/access-codes';
import { getEventWithVenue, listAccessCodes } from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('accessCodes') };
}

export default async function EventAccessCodesPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event } = row;
  const [t, codes] = await Promise.all([
    getTranslations('admin.accessCodes'),
    listAccessCodes(event.id),
  ]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('createTitle')}</CardTitle>
          <CardDescription>{t('createDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AccessCodeCreateForm
            action={createAccessCodesAction.bind(null, event.id)}
            timeZone={event.timeZone}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('listTitle', { count: codes.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          <AccessCodeTable
            timeZone={event.timeZone}
            codes={codes.map((c) => ({
              id: c.id,
              code: c.code,
              label: c.label,
              type: c.type,
              redemptionCount: c.redemptionCount,
              maxRedemptions: c.maxRedemptions,
              maxTicketsPerOrder: c.maxTicketsPerOrder,
              maxTicketsTotal: c.maxTicketsTotal,
              bypassesQueue: c.bypassesQueue,
              grantsPresaleAccess: c.grantsPresaleAccess,
              validFrom: c.validFrom?.toISOString() ?? null,
              validUntil: c.validUntil?.toISOString() ?? null,
              isActive: c.isActive,
              toggle: setAccessCodeActiveAction.bind(null, event.id, c.id, !c.isActive),
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
