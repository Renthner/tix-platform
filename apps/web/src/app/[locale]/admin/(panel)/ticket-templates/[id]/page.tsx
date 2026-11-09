import { getTicketTemplate } from '@tix/core';
import { events, mediaAssets } from '@tix/db';
import { defaultTicketLayout, ticketLayoutSchema } from '@tix/shared';
import { desc, eq, ne } from 'drizzle-orm';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/admin/form-controls';
import { TicketDesignerLoader } from '@/components/admin/ticket-designer/loader';
import { Button } from '@/components/ui/button';
import { resolveLocale } from '@/i18n/locale';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations('ticketDesigner');
  return { title: t('title') };
}

export default async function TicketTemplateEditorPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { db } = getCore();
  const template = await getTicketTemplate(db, id);
  if (!template) notFound();
  const t = await getTranslations('ticketDesigner');

  const layout = ticketLayoutSchema.safeParse(template.layout);
  const asset = async (assetId: string | null | undefined) => {
    if (!assetId) return null;
    const [row] = await db
      .select({
        id: mediaAssets.id,
        fileName: mediaAssets.fileName,
        width: mediaAssets.width,
        height: mediaAssets.height,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId));
    return row ?? null;
  };
  const [eventRow] = template.eventId
    ? await db
        .select({ hero: events.heroImageAssetId })
        .from(events)
        .where(eq(events.id, template.eventId))
    : [];
  const [background, cover] = await Promise.all([
    asset(template.backgroundAssetId),
    asset(eventRow?.hero),
  ]);
  // Preview data choices for library designs.
  const eventOptions = template.eventId
    ? []
    : await db
        .select({ id: events.id, title: events.title })
        .from(events)
        .where(ne(events.status, 'ARCHIVED'))
        .orderBy(desc(events.startsAt))
        .limit(50);

  return (
    <>
      <PageHeader
        title={t('page.editorTitle', { name: template.name })}
        description={t('page.editorDescription')}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link
              href={
                template.eventId
                  ? `/admin/events/${template.eventId}/ticket`
                  : '/admin/ticket-templates'
              }
            >
              <ArrowLeft className="size-4" />
              {t('page.back')}
            </Link>
          </Button>
        }
      />
      <TicketDesignerLoader
        templateId={template.id}
        eventId={template.eventId}
        coverAssetId={eventRow?.hero ?? null}
        coverAspect={cover?.width && cover.height ? cover.width / cover.height : 16 / 9}
        events={eventOptions}
        initial={{
          name: template.name,
          description: template.description,
          pageWidthMm: template.pageWidthMm,
          pageHeightMm: template.pageHeightMm,
          background,
          layout: layout.success ? layout.data : defaultTicketLayout(),
        }}
      />
    </>
  );
}
