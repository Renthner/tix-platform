import { computeSaleState, contentLocale, getSetting } from '@tix/core';
import { localized, SHOP_EVENTS_PER_ROW_MAX } from '@tix/shared';
import { events, mediaAssets, priceCategories, venues } from '@tix/db';
import { and, eq, inArray, min } from 'drizzle-orm';
import { CalendarDays, MapPin } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { StartPage, hasStartPageContent } from '@/components/shop/start-page';
import { shopOrderBy, shopVisibleCondition } from '@/server/shop-events';

export const dynamic = 'force-dynamic';

/** Narrowest card image ratio (w/h = 3:4). Taller portrait covers are cropped slightly
 *  (object-cover, centred) so they don't produce huge cards. Without stored size: 16:9. */
const MIN_COVER_ASPECT = 3 / 4;
function coverAspect(width: number | null, height: number | null): number {
  if (!width || !height) return 16 / 9;
  return Math.max(width / height, MIN_COVER_ASPECT);
}

export async function generateMetadata() {
  const t = await getTranslations('shop.home');
  return { title: t('title') };
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(params);
  const { db } = getCore();
  const content = await contentLocale(getCore(), locale);
  const L = (e: Parameters<typeof localized>[0], field: string, base: string | null) =>
    localized(e, field, content.locale, content.defaultLocale, base);
  const [t, format] = await Promise.all([getTranslations('shop'), getFormatter()]);
  const rows = await db
    .select({
      event: events,
      venue: { name: venues.name, city: venues.city, translations: venues.translations },
      cover: { id: mediaAssets.id, width: mediaAssets.width, height: mediaAssets.height },
    })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .leftJoin(mediaAssets, eq(mediaAssets.id, events.heroImageAssetId))
    .where(shopVisibleCondition())
    .orderBy(...shopOrderBy())
    .limit(100);
  const prices = rows.length
    ? await db
        .select({ eventId: priceCategories.eventId, from: min(priceCategories.basePrice) })
        .from(priceCategories)
        .where(
          and(
            inArray(
              priceCategories.eventId,
              rows.map((r) => r.event.id),
            ),
            eq(priceCategories.isActive, true),
          ),
        )
        .groupBy(priceCategories.eventId)
    : [];
  const fromPrice = new Map(prices.map((p) => [p.eventId, p.from]));

  // No event published: the configured start page replaces the built-in text.
  if (rows.length === 0) {
    const startPage = await getSetting(getCore(), 'startPage');
    if (hasStartPageContent(startPage, content.locale, content.defaultLocale)) {
      return (
        <StartPage
          settings={startPage}
          locale={content.locale}
          defaultLocale={content.defaultLocale}
        />
      );
    }
  }

  const perRow = Math.min(
    (await getSetting(getCore(), 'shopLayout')).eventsPerRow,
    SHOP_EVENTS_PER_ROW_MAX,
  );
  // Phones always show 1 card per row; wider screens 2 (sm) / 3 (md) / 4 (lg) at most, the
  // setting applies from xl on. The cards adapt to their own width (container queries):
  // compact below 20rem, side-by-side image and text from 48rem (e.g. 1 per row).
  const gridVars = {
    '--cols-sm': Math.min(perRow, 2),
    '--cols-md': Math.min(perRow, 3),
    '--cols-lg': Math.min(perRow, 4),
    '--cols-xl': perRow,
  } as React.CSSProperties;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('home.title')}</h1>
      {rows.length === 0 && <p className="text-muted-foreground">{t('home.empty')}</p>}
      <div
        style={gridVars}
        data-testid="event-grid"
        className={cn(
          'grid grid-cols-1 items-start gap-4 sm:grid-cols-[repeat(var(--cols-sm),minmax(0,1fr))] md:grid-cols-[repeat(var(--cols-md),minmax(0,1fr))] lg:grid-cols-[repeat(var(--cols-lg),minmax(0,1fr))] xl:grid-cols-[repeat(var(--cols-xl),minmax(0,1fr))]',
          perRow >= 5 && 'xl:gap-3',
        )}
      >
        {rows.map(({ event, venue, cover }) => {
          const state = computeSaleState(event);
          const price = fromPrice.get(event.id);
          const when = (dateStyle: 'full' | 'medium') =>
            format.dateTime(event.startsAt, {
              dateStyle,
              timeStyle: 'short',
              timeZone: event.timeZone,
            });
          return (
            <Card
              key={event.id}
              data-testid="event-card"
              className="@container/event gap-0 overflow-hidden py-0"
            >
              <div className="flex flex-col @3xl/event:flex-row">
                {cover?.id && (
                  <Link
                    href={`/events/${event.slug}`}
                    tabIndex={-1}
                    aria-hidden
                    className="block aspect-(--cover-aspect) overflow-hidden bg-muted @3xl/event:max-h-96 @3xl/event:w-2/5 @3xl/event:shrink-0 @3xl/event:self-start"
                    style={
                      {
                        '--cover-aspect': coverAspect(cover.width, cover.height),
                      } as React.CSSProperties
                    }
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/media/${cover.id}`}
                      alt=""
                      width={cover.width ?? 1600}
                      height={cover.height ?? 900}
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  </Link>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-3 py-4 @xs/event:gap-5 @xs/event:py-6 @3xl/event:justify-center @3xl/event:py-8">
                  <CardHeader className="gap-1.5 px-4 @xs/event:gap-2 @xs/event:px-6 @3xl/event:px-8">
                    <div className="flex flex-col-reverse items-start gap-1.5 @xs/event:flex-row @xs/event:justify-between @xs/event:gap-2">
                      <CardTitle className="text-base leading-snug break-words hyphens-auto @xs/event:text-lg @3xl/event:text-2xl">
                        {L(event, 'title', event.title)}
                      </CardTitle>
                      <Badge
                        variant={state === 'ON_SALE' ? 'default' : 'secondary'}
                        className="shrink-0"
                      >
                        {t(`saleState.${state}`)}
                      </Badge>
                    </div>
                    {event.subtitle && (
                      <p className="line-clamp-2 text-sm text-muted-foreground @3xl/event:line-clamp-none @3xl/event:text-base">
                        {L(event, 'subtitle', event.subtitle)}
                      </p>
                    )}
                  </CardHeader>
                  <CardContent className="flex-1 space-y-1 px-4 text-xs text-muted-foreground @xs/event:px-6 @xs/event:text-sm @3xl/event:flex-none @3xl/event:px-8 @3xl/event:text-base">
                    <p className="flex items-start gap-2">
                      <CalendarDays className="mt-0.5 size-4 shrink-0" />
                      <span className="hidden @xs/event:inline">{when('full')}</span>
                      <span className="@xs/event:hidden">{when('medium')}</span>
                    </p>
                    <p className="flex items-start gap-2">
                      <MapPin className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 break-words">
                        {[L(venue, 'name', venue.name), venue.city].filter(Boolean).join(', ')}
                      </span>
                    </p>
                    {price !== undefined && price !== null && (
                      <p>
                        {t('home.fromPrice', {
                          price: format.number(price / 100, {
                            style: 'currency',
                            currency: event.currency,
                          }),
                        })}
                      </p>
                    )}
                  </CardContent>
                  <CardFooter className="px-4 @xs/event:px-6 @3xl/event:px-8">
                    <Button
                      asChild
                      className="w-full @3xl/event:w-auto @3xl/event:min-w-48"
                      variant={state === 'ON_SALE' || state === 'PRESALE' ? 'default' : 'outline'}
                    >
                      <Link href={`/events/${event.slug}`}>{t('home.tickets')}</Link>
                    </Button>
                  </CardFooter>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
