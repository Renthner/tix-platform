import { ArrowLeft, Trash2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { PageHeader } from '@/components/admin/form-controls';
import { TemplateManager } from '@/components/admin/template-manager';
import { VenueForm } from '@/components/admin/venue-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { countVenueEvents, getVenue, listTemplates } from '@/server/admin/queries';
import {
  createTemplateAction,
  deleteTemplateAction,
  deleteVenueAction,
  duplicateTemplateAction,
  renameTemplateAction,
  saveVenueAction,
} from '@/server/admin/venues';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const venue = await getVenue((await params).id);
  return { title: venue?.name ?? '–' };
}

export default async function VenueDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const venue = await getVenue(id);
  if (!venue) notFound();
  const [t, templates, eventCount] = await Promise.all([
    getTranslations('admin.venues'),
    listTemplates(venue.id),
    countVenueEvents(venue.id),
  ]);

  return (
    <>
      <PageHeader
        title={venue.name}
        description={[venue.street, [venue.postalCode, venue.city].filter(Boolean).join(' ')]
          .filter(Boolean)
          .join(', ')}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/venues">
              <ArrowLeft /> {t('backToList')}
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 p-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('plans.title')}</CardTitle>
            <CardDescription>{t('plans.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <TemplateManager
              create={createTemplateAction.bind(null, venue.id)}
              templates={templates.map((tpl) => ({
                id: tpl.id,
                name: tpl.name,
                seats: tpl.seats,
                updatedAt: tpl.updatedAt.toISOString(),
                rename: renameTemplateAction.bind(null, tpl.id),
                duplicate: duplicateTemplateAction.bind(
                  null,
                  tpl.id,
                  t('plans.copyName', { name: tpl.name }),
                ),
                remove: deleteTemplateAction.bind(null, tpl.id),
              }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('edit')}</CardTitle>
          </CardHeader>
          <CardContent>
            <VenueForm
              action={saveVenueAction.bind(null, venue.id)}
              initial={{
                name: venue.name,
                slug: venue.slug,
                street: venue.street,
                postalCode: venue.postalCode,
                city: venue.city,
                country: venue.country,
                latitude: venue.latitude,
                longitude: venue.longitude,
                timeZone: venue.timeZone,
                websiteUrl: venue.websiteUrl,
                mapsUrl: venue.mapsUrl,
                description: venue.description,
                isActive: venue.isActive,
              }}
            />
          </CardContent>
        </Card>
        <Card className="border-destructive/40 xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('danger.title')}</CardTitle>
            <CardDescription>
              {eventCount > 0
                ? t('danger.hasEvents', { count: eventCount })
                : t('danger.description', { plans: templates.length })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConfirmAction
              action={deleteVenueAction.bind(null, venue.id)}
              title={t('danger.confirmTitle', { name: venue.name })}
              description={t('danger.confirmDescription', { plans: templates.length })}
              confirmLabel={t('danger.confirm')}
              disabled={eventCount > 0}
            >
              <Trash2 /> {t('danger.button')}
            </ConfirmAction>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
