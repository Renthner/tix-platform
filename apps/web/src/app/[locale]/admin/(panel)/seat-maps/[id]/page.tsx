import { getSeatMapMeta, listSymbols, loadSeatMapDocument } from '@tix/core';
import { events, priceCategories, venues } from '@tix/db';
import { asc, eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { resolveLocale } from '@/i18n/locale';
import { notFound } from 'next/navigation';
import { translationCompleteness, translationLocales } from '@tix/shared';
import { SeatMapEditorLoader } from '@/components/seatmap-editor/loader';
import { requireAdmin } from '@/server/auth';
import { getBaseContentLocale, getEditLocale } from '@/server/admin/edit-locale';
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

  // Content language: texts of blocks, elements and entrances (+ wheelchair / companion label texts).
  const baseLocale = await getBaseContentLocale();
  const editLocale = (await getEditLocale()) ?? baseLocale;
  const items = [
    ...doc.sections.map((s) => ({
      translations: s.translations,
      base: { name: s.name, ticketLabel: s.ticketLabel },
    })),
    ...doc.elements.map((el) => ({ translations: el.translations, base: { label: el.label } })),
    ...doc.categories.map((c) => ({ translations: c.translations, base: { name: c.name } })),
    ...doc.entrances.map((en) => ({ translations: en.translations, base: { name: en.name } })),
    {
      translations: doc.settings.translations,
      base: {
        wheelchairLabelText:
          doc.settings.wheelchairLabel?.mode === 'TEXT' ? doc.settings.wheelchairLabel.text : null,
        companionLabelText:
          doc.settings.companionLabel?.mode === 'TEXT' ? doc.settings.companionLabel.text : null,
      },
    },
  ];
  const options = translationLocales(baseLocale).map((locale) => ({
    locale,
    ...translationCompleteness(items, locale),
  }));

  return (
    <SeatMapEditorLoader
      translation={{ baseLocale, editLocale, options }}
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
