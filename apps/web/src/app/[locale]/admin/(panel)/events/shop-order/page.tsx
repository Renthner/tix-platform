import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { ShopOrderEditor } from '@/components/admin/shop-order-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { formatInZone } from '@/lib/datetime';
import { requireAdmin } from '@/server/auth';
import { listShopVisibleEvents } from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.shopOrder');
  return { title: t('title') };
}

export default async function ShopOrderPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const [t, rows] = await Promise.all([
    getTranslations('admin.shopOrder'),
    listShopVisibleEvents(),
  ]);
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/events">
              <ArrowLeft /> {t('back')}
            </Link>
          </Button>
        }
      />
      <div className="space-y-4 p-6">
        <p className="text-sm text-muted-foreground">{t('rule')}</p>
        <Card>
          <CardContent>
            <ShopOrderEditor
              initial={rows.map((r) => ({
                id: r.id,
                title: r.title,
                when: formatInZone(r.startsAt, r.timeZone, locale),
                venue: r.venueName,
                startsAtMs: r.startsAt.getTime(),
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
