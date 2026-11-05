import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { QueueConfigForm } from '@/components/admin/queue-forms';
import { Card, CardContent } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { queueFormValues } from '@/server/admin/queue-defaults';
import { saveQueueConfigAction } from '@/server/admin/queue';

export async function generateMetadata() {
  const t = await getTranslations('admin.queue');
  return { title: t('globalTitle') };
}

export default async function GlobalWaitingRoomPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const [t, form] = await Promise.all([getTranslations('admin.queue'), queueFormValues(null)]);
  return (
    <>
      <PageHeader title={t('globalTitle')} description={t('globalDescription')} />
      <div className="p-6">
        <Card>
          <CardContent>
            <QueueConfigForm
              action={saveQueueConfigAction.bind(null, null)}
              initial={form.values}
              scope="global"
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
