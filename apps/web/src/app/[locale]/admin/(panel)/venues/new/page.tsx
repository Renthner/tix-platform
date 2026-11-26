import { getSetting } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { AdminPageHeader } from '@/components/admin/page-header';
import { VenueForm } from '@/components/admin/venue-form';
import { Card, CardContent } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { saveVenueAction } from '@/server/admin/venues';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.venues');
  return { title: t('new') };
}

export default async function NewVenuePage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const [t, general, organizer, breadcrumbs] = await Promise.all([
    getTranslations('admin.venues'),
    getSetting(getCore(), 'general'),
    getSetting(getCore(), 'organizer'),
    hubBreadcrumbs('venues'),
  ]);
  return (
    <>
      <AdminPageHeader
        breadcrumbs={breadcrumbs}
        title={t('new')}
        description={t('newDescription')}
      />
      <div className="max-w-4xl p-6">
        <Card>
          <CardContent>
            <VenueForm
              action={saveVenueAction.bind(null, null)}
              initial={{
                name: '',
                slug: '',
                street: null,
                postalCode: null,
                city: null,
                country: organizer.country,
                latitude: null,
                longitude: null,
                timeZone: general.defaultTimeZone,
                websiteUrl: null,
                mapsUrl: null,
                description: null,
                isActive: true,
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
