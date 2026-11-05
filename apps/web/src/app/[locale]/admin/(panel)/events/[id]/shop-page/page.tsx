import { listSymbols } from '@tix/core';
import { normalizePageLayout } from '@tix/shared';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EventPageEditor } from '@/components/admin/event-page-editor';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { updateEventPageAction } from '@/server/admin/event-page';
import { getEventWithVenue } from '@/server/admin/queries';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('page') };
}

/** Event page designer: block order (drag & drop) and info boxes. */
export default async function EventShopPage({
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
  const [t, symbolRows] = await Promise.all([
    getTranslations('admin.events.page'),
    listSymbols(getCore().db, 'ELEMENT'),
  ]);
  const byKey = new Map(symbolRows.map((s) => [s.builtinKey, s.id]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <EventPageEditor
          action={updateEventPageAction.bind(null, event.id)}
          initialLayout={normalizePageLayout(
            event.pageLayout,
            event.infoBoxes.map((b) => b.id),
          )}
          initialBoxes={event.infoBoxes.map((b) => ({
            ...b,
            textSize: b.textSize ?? 'M',
            iconSize: b.iconSize ?? 'M',
          }))}
          symbols={symbolRows.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            viewBox: s.viewBox,
            markup: s.markup,
            colorize: s.colorize,
          }))}
          templateSymbols={{
            discounts: byKey.get('icon-info') ?? null,
            accessibility: byKey.get('icon-accessible') ?? null,
          }}
        />
      </CardContent>
    </Card>
  );
}
