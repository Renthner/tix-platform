import {
  computeSaleState,
  effectiveCheckoutConfig,
  getDraftEventBySlug,
  getPublicSeatMap,
  getSetting,
  getShopAnnouncements,
  getShopEventBySlug,
  getShopQueueConfig,
  localizeEventRow,
  localizeVenueRow,
  saleOpensAt,
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
import { CalendarDays, DoorOpen, ExternalLink, MapPin } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache, type CSSProperties, type ReactNode } from 'react';
import { MediaImage } from '@/components/media-image';
import { DraftBanner } from '@/components/shop/draft-banner';
import { EventShop } from '@/components/shop/event-shop';
import { Badge } from '@/components/ui/badge';
import { resolveLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import { getCore } from '@/server/core';
import { getShopActor } from '@/server/shop-actor';
import { buildEventJsonLd, jsonLdString } from '@/server/event-jsonld';
import { descriptionToHtml } from '@/server/rich-text';
import {
  loadContentLocale,
  loadSeoContext,
  localeUrl,
  pageSeo,
  plainSnippet,
  publicBaseUrl,
} from '@/server/seo';

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

/**
 * Event, venue, cover and info box symbols of a slug from the shop data cache (tag invalidated
 * by every admin change, see docs/ARCHITECTURE.md); memoised per request on top.
 */
const loadEvent = cache(async (slug: string) => {
  const published = await getShopEventBySlug(getCore(), slug);
  if (published) return published;
  // Draft events: signed-in super-admins only (role checked per request), loaded WITHOUT the
  // public shop cache so draft data never enters keys any visitor can reach.
  return (await getShopActor()) ? getDraftEventBySlug(getCore(), slug) : null;
});

export async function generateMetadata({ params }: Params) {
  const { slug, locale } = await params;
  const raw = await loadEvent(slug);
  if (!raw) return {};
  // Drafts are never indexed (and never get canonical / alternate links).
  if (raw.event.status === 'DRAFT')
    return { title: raw.event.title, robots: { index: false, follow: false } };
  // Excluded from search engines (event tab "Sales"): same as a draft, no canonical / alternates.
  const ctx = await loadSeoContext(locale);
  const { content } = ctx;
  if (raw.event.seoNoindex)
    return {
      title: localizeEventRow(raw.event, content.locale, content.defaultLocale).title,
      robots: { index: false, follow: false },
    };
  const event = localizeEventRow(raw.event, content.locale, content.defaultLocale);
  const description =
    event.subtitle || plainSnippet(event.description) || ctx.description || undefined;
  const cover = raw.cover;
  return {
    title: event.title,
    description,
    ...pageSeo({
      path: `/events/${event.slug}`,
      locale: content.locale,
      defaultLocale: content.defaultLocale,
      title: event.title,
      description,
      siteName: ctx.siteTitle,
      // Event cover first, else the configured share image.
      image: cover
        ? {
            url: `${publicBaseUrl()}/api/media/${cover.id}`,
            width: cover.width,
            height: cover.height,
          }
        : ctx.shareImage,
      twitterSite: ctx.seo.twitterHandle,
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
  const [checkout, queue, format, t, announcements, seatDisplay, priceRange, organizer, nonce] =
    await Promise.all([
      effectiveCheckoutConfig(core, event),
      getShopQueueConfig(core, event.id),
      getFormatter(),
      getTranslations('shop.event'),
      getShopAnnouncements(core, event.id),
      getSetting(core, 'seatDisplay'),
      // Only needed for structured data, which drafts do not get.
      event.seatMapId && found.event.status !== 'DRAFT'
        ? getPublicSeatMap(core, found.event)
            .then((map) => publicPriceRanges(map).overall)
            // Structured data is auxiliary: never fail the page because of it.
            .catch(() => null)
        : null,
      getSetting(core, 'organizer'),
      headers().then((h) => h.get('x-nonce') ?? undefined),
    ]);
  const cover = found.cover;
  const base = publicBaseUrl();
  const isDraft = found.event.status === 'DRAFT';
  // No structured data for drafts, events excluded from search engines or while indexing is off.
  const seoIndexing = (await getSetting(core, 'seo')).indexing;
  const jsonLd =
    isDraft || found.event.seoNoindex || !seoIndexing
      ? null
      : jsonLdString(
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
  const boxSymbols = new Map(Object.entries(found.symbols));
  const descriptionHtml = descriptionToHtml(event.description);
  const boxById = new Map(infoBoxes.map((b) => [b.id, b]));
  const layoutRows = normalizePageLayout(
    event.pageLayout,
    infoBoxes.map((b) => b.id),
  );

  return (
    <div className="space-y-6">
      {jsonLd && (
        <script
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: jsonLd }}
        />
      )}
      {isDraft && <DraftBanner />}
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
