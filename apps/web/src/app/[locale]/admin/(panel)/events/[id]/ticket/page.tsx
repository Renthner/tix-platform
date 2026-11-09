import { listTicketTemplates, resolveTicketTemplate } from '@tix/core';
import { priceCategories, ticketTemplates } from '@tix/db';
import { asc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  CategoryTemplateAssignment,
  CreateEventTemplateForm,
  EventTemplateAssignment,
  type TemplateOption,
} from '@/components/admin/ticket-designer/forms';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/server/auth';
import { getEventWithVenue } from '@/server/admin/queries';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('ticketDesigner.eventTab');
  return { title: t('tab') };
}

export default async function EventTicketPage({
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
  const { db } = getCore();
  const t = await getTranslations('ticketDesigner.eventTab');

  const [library, own, categories, effective] = await Promise.all([
    listTicketTemplates(db),
    listTicketTemplates(db, { eventId: event.id }),
    db
      .select({
        id: priceCategories.id,
        name: priceCategories.name,
        templateId: priceCategories.ticketTemplateId,
      })
      .from(priceCategories)
      .where(eq(priceCategories.eventId, event.id))
      .orderBy(asc(priceCategories.sortOrder), asc(priceCategories.name)),
    resolveTicketTemplate(db, { eventId: event.id }),
  ]);
  const options: TemplateOption[] = [
    ...own.map((tpl) => ({ id: tpl.id, name: tpl.name, eventOwned: true })),
    ...library.map((tpl) => ({ id: tpl.id, name: tpl.name, eventOwned: false })),
  ];
  const assigned = [...own, ...library].find((tpl) => tpl.id === event.ticketTemplateId);
  const effectiveName = effective.templateId
    ? ([...own, ...library].find((tpl) => tpl.id === effective.templateId)?.name ??
      (await db
        .select({ name: ticketTemplates.name })
        .from(ticketTemplates)
        .where(eq(ticketTemplates.id, effective.templateId))
        .then((r) => r[0]?.name)) ??
      t('builtin'))
    : t('builtin');

  return (
    <div className="space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <EventTemplateAssignment
            eventId={event.id}
            eventTemplateId={assigned ? assigned.id : null}
            options={options}
          />
          <p className="text-sm text-muted-foreground">
            {t('effective', { name: effectiveName })}
            {effective.templateId && (
              <Button asChild variant="link" size="sm">
                <Link href={`/admin/ticket-templates/${effective.templateId}`}>{t('edit')}</Link>
              </Button>
            )}
          </p>
        </CardContent>
      </Card>

      {categories.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('categoryOverrides')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryTemplateAssignment
              eventId={event.id}
              categories={categories}
              options={options}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('customize.title')}</CardTitle>
          <CardDescription>{t('customize.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateEventTemplateForm
            eventId={event.id}
            options={options}
            categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
