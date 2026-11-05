import { getSetting } from '@tix/core';
import { venues } from '@tix/db';
import { asc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { EventCreateForm } from '@/components/admin/event-forms';
import { PageHeader } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { createEventAction } from '@/server/admin/events';
import { listAllTemplates, listTaxRates } from '@/server/admin/queries';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.events');
  return { title: t('new') };
}

export default async function NewEventPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  const [t, venueRows, templates, taxRates, general, checkout] = await Promise.all([
    getTranslations('admin.events'),
    core.db
      .select({ id: venues.id, name: venues.name, timeZone: venues.timeZone })
      .from(venues)
      .where(eq(venues.isActive, true))
      .orderBy(asc(venues.name)),
    listAllTemplates(),
    listTaxRates(),
    getSetting(core, 'general'),
    getSetting(core, 'checkout'),
  ]);

  return (
    <>
      <PageHeader title={t('new')} description={t('create.description')} />
      <div className="p-6">
        {venueRows.length === 0 || taxRates.length === 0 ? (
          <Alert>
            <AlertDescription>
              {venueRows.length === 0 ? t('create.noVenues') : t('create.noTaxRates')}{' '}
              {venueRows.length === 0 && (
                <Link href="/admin/venues/new" className="underline">
                  {t('create.createVenue')}
                </Link>
              )}
            </AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardContent>
              <EventCreateForm
                action={createEventAction}
                venues={venueRows}
                templates={templates}
                taxRates={taxRates.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault }))}
                defaults={{
                  timeZone: general.defaultTimeZone,
                  currency: general.defaultCurrency,
                  orphanSeatRuleEnabled: checkout.orphanSeatRuleEnabled,
                }}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
