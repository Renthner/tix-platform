import {
  computeSaleState,
  effectiveCheckoutConfig,
  effectiveQueueConfig,
  getEventWithVenueBySlug,
  getMediaAsset,
  getPublicSeatMap,
  getSetting,
  localizeEventRow,
  localizeVenueRow,
  saleOpensAt,
  symbolsByIds,
  type VenueRow,
} from '@tix/core';
import {
  INFO_BOX_ICON_PX,
  localized,
  normalizePageLayout,
  publicPriceRanges,
  type InfoBoxSize,
  type PageBlockRef,
} from '@tix/shared';
import { queueAnnouncements } from '@tix/db';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { CalendarDays, DoorOpen, ExternalLink, MapPin } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache, type CSSProperties, type ReactNode } from 'react';
import { MediaImage } from '@/components/media-image';
import { EventShop } from '@/components/shop/event-shop';
import { Badge } from '@/components/ui/badge';
import { resolveLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import { getCore } from '@/server/core';
import { buildEventJsonLd, jsonLdString } from '@/server/event-jsonld';
import { descriptionToHtml } from '@/server/rich-text';
import { loadContentLocale, localeUrl, pageSeo, plainSnippet, publicBaseUrl } from '@/server/seo';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ locale: string; slug: string }> };

/** The venue's own Google Maps link, else a search link from coordinates / address. */
function mapsUrl(venue: VenueRow): string {
  if (venue.mapsUrl && /^https?:\/\//i.test(venue.mapsUrl)) return venue.mapsUrl;
  const query =
    venue.latitude !== null && venue.longitude !== null
      ? `${venue.latitude},${venue.longitude}`
      : [venue.name, venue.street, venue.postalCode, venue.city, venue.country]
          .filter(Boolean)
          .join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

const loadEvent = cache(async (slug: string) => {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return null;
  const found = await getEventWithVenueBySlug(getCore(), slug);
  if (!found || (found.event.status !== 'PUBLISHED' && found.event.status !== 'POSTPONED'))
    return null;
  return found;
});

const loadCover = cache((id: string) => getMediaAsset(getCore(), id));

export async function generateMetadata({ params }: Params) {
  const { slug, locale } = await params;
  const raw = await loadEvent(slug);
  if (!raw) return {};
  const [content, general] = await Promise.all([
    loadContentLocale(locale),
    getSetting(getCore(), 'general'),
  ]);
  const event = localizeEventRow(raw.event, content.locale, content.defaultLocale);
  const description = event.subtitle || plainSnippet(event.description) || undefined;
  const cover = event.heroImageAssetId ? await loadCover(event.heroImageAssetId) : null;
  return {
    title: event.title,
    description,
    ...pageSeo({
      path: `/events/${event.slug}`,
      locale: content.locale,
      defaultLocale: content.defaultLocale,
      title: event.title,
      description,
      siteName: general.shopName,
      image: cover
        ? {
            url: `${publicBaseUrl()}/api/media/${cover.id}`,
            width: cover.width,
            height: cover.height,
          }
        : undefined,
    }),
  };
}

export default async function EventPage({ params }: Params) {
  const locale = await resolveLocale(params);
  const found = await loadEvent((await params).slug);
  if (!found) notFound();
  const core = getCore();
  const content = await loadContentLocale(locale);
  const event = localizeEventRow(found.event, content.locale, content.defaultLocale);
  const venue = localizeVenueRow(found.venue, content.locale, content.defaultLocale);
  const [
    checkout,
    queue,
    format,
    t,
    announcements,
    seatDisplay,
    cover,
    priceRange,
    organizer,
    nonce,
  ] = await Promise.all([
    effectiveCheckoutConfig(core, event),
    effectiveQueueConfig(core, event.id),
    getFormatter(),
    getTranslations('shop.event'),
    core.db
      .select()
      .from(queueAnnouncements)
      .where(
        and(
          or(eq(queueAnnouncements.eventId, event.id), isNull(queueAnnouncements.eventId)),
          or(isNull(queueAnnouncements.expiresAt), gt(queueAnnouncements.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(queueAnnouncements.publishedAt))
      .limit(5),
    getSetting(core, 'seatDisplay'),
    event.heroImageAssetId ? loadCover(event.heroImageAssetId) : null,
    event.seatMapId
      ? getPublicSeatMap(core, found.event)
          .then((map) => publicPriceRanges(map).overall)
          // Structured data is auxiliary: never fail the page because of it.
          .catch(() => null)
      : null,
    getSetting(core, 'organizer'),
    headers().then((h) => h.get('x-nonce') ?? undefined),
  ]);
  const base = publicBaseUrl();
  const jsonLd = jsonLdString(
    buildEventJsonLd({
      url: localeUrl(content.locale, `/events/${event.slug}`, content.defaultLocale),
      name: event.title,
      description: event.subtitle || plainSnippet(event.description, 500) || undefined,
      status: event.status,
      saleState: computeSaleState(found.event),
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      doorsOpenAt: event.doorsOpenAt,
      timeZone: event.timeZone,
      currency: event.currency,
      priceRange,
      saleOpensAt: saleOpensAt(found.event),
      images: cover ? [`${base}/api/media/${cover.id}`] : [],
      venue,
      organizer: { name: organizer.legalName, url: organizer.website },
    }),
  );
  const infoBoxes = event.infoBoxes.filter((b) => b.title || b.content);
  const boxSymbols = new Map(
    (
      await symbolsByIds(
        core.db,
        infoBoxes.flatMap((b) => (b.symbolId ? [b.symbolId] : [])),
      )
    ).map((sym) => [sym.id, sym]),
  );
  const descriptionHtml = descriptionToHtml(event.description);
  const boxById = new Map(infoBoxes.map((b) => [b.id, b]));
  const layoutRows = normalizePageLayout(
    event.pageLayout,
    infoBoxes.map((b) => b.id),
  );

  return (
    <div className="space-y-6">
      <script
        type="application/ld+json"
        nonce={nonce}
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{event.title}</h1>
          {event.status === 'POSTPONED' && <Badge variant="destructive">{t('postponed')}</Badge>}
        </div>
        {event.subtitle && <p className="text-muted-foreground">{event.subtitle}</p>}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <CalendarDays className="size-4" />
            {format.dateTime(event.startsAt, {
              dateStyle: 'full',
              timeStyle: 'short',
              timeZone: event.timeZone,
            })}
          </span>
          {event.doorsOpenAt && (
            <span className="flex items-center gap-2">
              <DoorOpen className="size-4" />
              {t('doors', {
                time: format.dateTime(event.doorsOpenAt, {
                  timeStyle: 'short',
                  timeZone: event.timeZone,
                }),
              })}
            </span>
          )}
          <a
            href={mapsUrl(venue)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 underline-offset-4 hover:text-foreground hover:underline"
            title={t('showOnMap')}
          >
            <MapPin className="size-4" />
            {[venue.name, venue.street, venue.city].filter(Boolean).join(', ')}
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">{t('showOnMap')}</span>
          </a>
        </div>
      </div>

      {layoutRows.map((row) => {
        const cells = row
          .map((item) => ({ item, node: renderBlock(item.ref, row.length > 1) }))
          .filter((cell) => cell.node);
        if (cells.length === 0) return null;
        return (
          <div
            key={row.map((i) => i.ref).join('|')}
            data-row
            className="grid items-start gap-6 md:[grid-template-columns:var(--cols)]"
            style={
              {
                '--cols': cells.map((c) => `minmax(0,${c.item.span}fr)`).join(' '),
              } as CSSProperties
            }
          >
            {cells.map(({ item, node }) => (
              <div key={item.ref} data-block={item.ref} className="min-w-0">
                {node}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );

  /** Content of one block (layout set by the admin; empty blocks render nothing). */
  function renderBlock(ref: PageBlockRef, shared: boolean): ReactNode {
    if (ref === 'COVER') {
      if (!cover) return null;
      // Any format: natural aspect ratio (no layout shift), shown in full, height capped;
      // scales down inside a narrow column.
      // The event cover is the largest image above the fold (LCP): load it eagerly with high priority.
      return (
        <MediaImage
          assetId={cover.id}
          alt={cover.altText ?? ''}
          width={cover.width}
          height={cover.height}
          sizes="(min-width: 1280px) 1280px, 100vw"
          loading="eager"
          fetchPriority="high"
          className="mx-auto h-auto max-h-[32rem] w-full rounded-xl border bg-muted/30 object-contain"
        />
      );
    }
    if (ref === 'DESCRIPTION') {
      if (!descriptionHtml) return null;
      return (
        <div
          className={cn('rich-text text-sm', !shared && 'max-w-3xl')}
          dangerouslySetInnerHTML={{ __html: descriptionHtml }}
        />
      );
    }
    if (ref !== 'SHOP') {
      const box = boxById.get(ref.slice(4));
      if (!box) return null;
      const symbol = box.symbolId ? boxSymbols.get(box.symbolId) : undefined;
      const size = box.textSize ?? 'M';
      const iconPx = INFO_BOX_ICON_PX[box.iconSize ?? 'M'];
      return (
        <section className="flex h-full gap-4 rounded-lg border bg-card p-5">
          {symbol && (
            <svg
              viewBox={symbol.viewBox}
              width={iconPx}
              height={iconPx}
              className="shrink-0 text-primary"
              fill={symbol.colorize ? 'currentColor' : undefined}
              aria-hidden
              // Library markup is sanitised on upload (shape elements only).
              dangerouslySetInnerHTML={{ __html: symbol.markup }}
            />
          )}
          <div className="min-w-0 space-y-2">
            {box.title && (
              <h2 className={cn('font-semibold leading-tight', BOX_TITLE_SIZE[size])}>
                {box.title}
              </h2>
            )}
            {box.content && (
              // Sanitised with the rich-text allowlist when saved.
              <div
                className={cn('rich-text', BOX_TEXT_SIZE[size])}
                dangerouslySetInnerHTML={{ __html: box.content }}
              />
            )}
          </div>
        </section>
      );
    }
    return (
      <EventShop
        eventId={event.id}
        config={{
          manualSeatSelectionEnabled: checkout.manualSeatSelectionEnabled,
          bestAvailableEnabled: checkout.bestAvailableEnabled,
          maxTicketsPerOrder: checkout.maxTicketsPerOrder,
          orphanSeatRuleEnabled: checkout.orphanSeatRuleEnabled,
          companionRequiresWheelchair: checkout.companionRequiresWheelchair,
        }}
        seatColors={seatDisplay}
        queue={{
          title: localized(queue, 'title', locale, content.defaultLocale, queue.title) || null,
          message:
            localized(queue, 'message', locale, content.defaultLocale, queue.message) || null,
          admissionBatchSize: queue.admissionBatchSize,
          admissionIntervalSeconds: queue.admissionIntervalSeconds,
        }}
        defaultLocale={content.defaultLocale}
        announcements={announcements.map((a) => ({
          id: a.id,
          message: a.message,
          translations: a.translations,
          severity: a.severity,
          publishedAt: a.publishedAt.toISOString(),
        }))}
      />
    );
  }
}

/** Text sizes of info boxes (title scales along). */
const BOX_TEXT_SIZE: Record<InfoBoxSize, string> = {
  S: 'text-sm',
  M: 'text-base',
  L: 'text-lg',
  XL: 'text-xl',
};
const BOX_TITLE_SIZE: Record<InfoBoxSize, string> = {
  S: 'text-base',
  M: 'text-lg',
  L: 'text-xl',
  XL: 'text-2xl',
};
