import { getSeatMapMeta, listSymbols, loadSeatMapDocument } from '@tix/core';
import { events, priceCategories, venues } from '@tix/db';
import { asc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { resolveLocale } from '@/i18n/locale';
import { notFound } from 'next/navigation';
import { SeatMapEditorLoader } from '@/components/seatmap-editor/loader';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('editor');
  return { title: t('pageTitle') };
}

export default async function SeatMapEditorPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  const meta = /^[0-9a-f-]{36}$/i.test(id) ? await getSeatMapMeta(db, id) : null;
  if (!meta) notFound();
  const doc = await loadSeatMapDocument(db, id);
  if (!doc) notFound();

  const [venue] = await db
    .select({ name: venues.name })
    .from(venues)
    .where(eq(venues.id, meta.venueId));
  let title = venue?.name ?? '';
  let backHref = `/admin/venues/${meta.venueId}`;
  let categories: { id: string; name: string; color: string }[] = [];
  if (meta.eventId) {
    const [event] = await db
      .select({ title: events.title })
      .from(events)
      .where(eq(events.id, meta.eventId));
    title = event?.title ?? title;
    backHref = `/admin/events/${meta.eventId}`;
    categories = await db
      .select({ id: priceCategories.id, name: priceCategories.name, color: priceCategories.color })
      .from(priceCategories)
      .where(eq(priceCategories.eventId, meta.eventId))
      .orderBy(asc(priceCategories.sortOrder), asc(priceCategories.name));
  }

  const symbols = (await listSymbols(db)).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    viewBox: s.viewBox,
    markup: s.markup,
    colorize: s.colorize,
  }));

  return (
    <SeatMapEditorLoader
      symbols={symbols}
      seatMapId={id}
      kind={meta.kind}
      initialDocument={doc}
      categories={categories}
      title={title}
      backHref={backHref}
    />
  );
}
