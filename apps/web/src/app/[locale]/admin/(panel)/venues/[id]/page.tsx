import { ExternalLink, Trash2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ActiveBadge } from '@/components/admin/badges';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { AdminPageHeader } from '@/components/admin/page-header';
import { SeatPlanImport } from '@/components/admin/seat-plan-import';
import { TemplateManager } from '@/components/admin/template-manager';
import { VenueForm } from '@/components/admin/venue-form';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
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
  const [t, templates, eventCount, breadcrumbs] = await Promise.all([
    getTranslations('admin.venues'),
    listTemplates(venue.id),
    countVenueEvents(venue.id),
    hubBreadcrumbs('venues'),
  ]);
  const address = [venue.street, [venue.postalCode, venue.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const link = (href: string, label: string) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
    >
      {label} <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );

  return (
    <>
      <AdminPageHeader breadcrumbs={breadcrumbs} title={venue.name} description={address} />
      <DetailLayout
        aside={
          <>
            <DetailSection title={t('facts.title')} data-testid="venue-facts">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('columns.status')}</dt>
                <dd>
                  <ActiveBadge active={venue.isActive} />
                </dd>
                <dt className="text-muted-foreground">{t('columns.plans')}</dt>
                <dd className="tabular-nums">{templates.length}</dd>
                <dt className="text-muted-foreground">{t('facts.events')}</dt>
                <dd className="tabular-nums">{eventCount}</dd>
                <dt className="text-muted-foreground">{t('form.timeZone')}</dt>
                <dd className="break-all">{venue.timeZone}</dd>
                {venue.websiteUrl ? (
                  <>
                    <dt className="text-muted-foreground">{t('form.websiteUrl')}</dt>
                    <dd className="min-w-0 break-all">
                      {link(venue.websiteUrl, venue.websiteUrl.replace(/^https?:\/\//, ''))}
                    </dd>
                  </>
                ) : null}
                {venue.mapsUrl ? (
                  <>
                    <dt className="text-muted-foreground">{t('form.mapsUrl')}</dt>
                    <dd>{link(venue.mapsUrl, t('facts.openMap'))}</dd>
                  </>
                ) : null}
              </dl>
            </DetailSection>
            <DetailSection
              title={t('danger.title')}
              className="border-destructive/40"
              description={
                eventCount > 0
                  ? t('danger.hasEvents', { count: eventCount })
                  : t('danger.description', { plans: templates.length })
              }
            >
              <ConfirmAction
                action={deleteVenueAction.bind(null, venue.id)}
                title={t('danger.confirmTitle', { name: venue.name })}
                description={t('danger.confirmDescription', { plans: templates.length })}
                confirmLabel={t('danger.confirm')}
                disabled={eventCount > 0}
              >
                <Trash2 /> {t('danger.button')}
              </ConfirmAction>
            </DetailSection>
          </>
        }
      >
        <DetailSection title={t('plans.title')} description={t('plans.description')}>
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
          <div className="mt-4">
            <SeatPlanImport venueId={venue.id} />
          </div>
        </DetailSection>
        <DetailSection title={t('edit')}>
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
        </DetailSection>
      </DetailLayout>
    </>
  );
}
