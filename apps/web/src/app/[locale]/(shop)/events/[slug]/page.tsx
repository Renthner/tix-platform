import {
  computeSaleState,
  effectiveCheckoutConfig,
  getDraftEventBySlug,
  getPublicSeatMap,
  getLocalizedPublicSeatMap,
  getSetting,
  getShopAnnouncements,
  getWaitlistOffer,
  getShopEventBySlug,
  getShopQueueConfig,
  localizeEventRow,
  localizeVenueRow,
  saleOpensAt,
} from '@tix/core';
import {
  INFO_BOX_ICON_PX,
  localized,
  normalizePageLayout,
  protectEmailsInHtml,
  publicPriceRanges,
  venueMapsUrl,
  type InfoBoxSize,
  type PageBlockRef,
} from '@tix/shared';
import { ShareButton } from '@/components/shop/share-button';
import { CalendarDays, CalendarPlus, DoorOpen, ExternalLink, MapPin } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache, type CSSProperties, type ReactNode } from 'react';
import { MediaImage } from '@/components/media-image';
import { DraftBanner } from '@/components/shop/draft-banner';
import { EventShop } from '@/components/shop/event-shop';
import { WaitlistBlock } from '@/components/shop/waitlist-block';
import { Badge } from '@/components/ui/badge';
import { resolveLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import { getCore } from '@/server/core';
import { reportPageCacheBoundary } from '@/server/page-cache';
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
  const venue = found.venue
    ? localizeVenueRow(found.venue, content.locale, content.defaultLocale)
    : null;
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
  // Waiting list block: counts per category (the block decides itself whether the banner shows,
  // also live). Never for drafts; an unreadable inventory must not break the page.
  const waitlistOffer =
    found.event.status === 'DRAFT' || !found.event.seatMapId
      ? null
      : await getLocalizedPublicSeatMap(core, found.event, content.locale)
          .then((map) =>
            getWaitlistOffer(
              core,
              found.event,
              new Map(map.categories.map((c) => [c.id, c.name] as const)),
            ),
          )
          .catch(() => null);
  const cover = found.cover;
  const base = publicBaseUrl();
  const isDraft = found.event.status === 'DRAFT';
  // No structured data for drafts, events excluded from search engines or while indexing is off,
  // nor for admission-only events without a venue (Google requires `location`, see
  // buildEventJsonLd).
  const seoIndexing = (await getSetting(core, 'seo')).indexing;
  const jsonLd =
    isDraft || found.event.seoNoindex || !seoIndexing || !venue
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
  // HTML page cache: a shared render must not outlive the event's next sale-state change (which
  // also decides the waiting-list block) nor the expiry of a shown announcement. The waiting-room
  // state (lobby, countdown) is fetched by the browser, not rendered here.
  reportPageCacheBoundary(await headers(), [
    found.event.presaleStartsAt,
    found.event.publicSaleStartsAt,
    found.event.saleEndsAt,
    found.event.startsAt,
    ...announcements.map((a) => a.expiresAt),
  ]);
  const infoBoxes = event.infoBoxes.filter((b) => b.title || b.content);
  const boxSymbols = new Map(Object.entries(found.symbols));
  const descriptionHtml = descriptionToHtml(event.description);
  const boxById = new Map(infoBoxes.map((b) => [b.id, b]));
  const layoutRows = normalizePageLayout(
    event.pageLayout,
    infoBoxes.map((b) => b.id),
  );

  return (
    <div className="flex flex-col gap-6">
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
          {venue && (
            <a
              href={venueMapsUrl(venue)}
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
          )}
          <a
            href={`/api/events/${event.id}/calendar.ics?locale=${content.locale}`}
            className="flex items-center gap-2 underline-offset-4 hover:text-foreground hover:underline"
          >
            <CalendarPlus className="size-4" />
            {t('addToCalendar')}
          </a>
          {!isDraft && <ShareButton title={event.title} />}
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
            // Stacked on mobile, side by side from md on (width ∝ span). Flex, not grid: a block that
            // renders nothing for now (the waiting list while tickets are available) leaves no gap, and
            // a row without visible content disappears completely.
            className="grid gap-6 md:flex md:items-start [&:not(:has(>[data-block]:not(:empty)))]:hidden"
          >
            {cells.map(({ item, node }) => (
              <div
                key={item.ref}
                data-block={item.ref}
                className="min-w-0 empty:hidden md:[flex:var(--span)_1_0%]"
                style={{ '--span': item.span } as CSSProperties}
              >
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
    if (ref === 'WAITLIST') {
      if (!waitlistOffer) return null;
      return (
        <WaitlistBlock
          eventId={event.id}
          trigger={waitlistOffer.trigger}
          maxTickets={waitlistOffer.maxTickets}
          categories={waitlistOffer.categories}
        />
      );
    }
    if (ref === 'DESCRIPTION') {
      if (!descriptionHtml) return null;
      return (
        <div
          className={cn('rich-text text-sm', !shared && 'max-w-3xl')}
          dangerouslySetInnerHTML={{ __html: protectEmailsInHtml(descriptionHtml) }}
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
                dangerouslySetInnerHTML={{ __html: protectEmailsInHtml(box.content) }}
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
          admission: event.seatingMode === 'ADMISSION',
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
