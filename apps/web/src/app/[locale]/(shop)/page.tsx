import { computeSaleState, contentLocale, getSetting } from '@tix/core';
import { localized } from '@tix/shared';
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

  const perRow = (await getSetting(getCore(), 'shopLayout')).eventsPerRow;
  // Fewer columns on narrower screens: 1 (phone) / ≤2 (sm) / ≤3 (md) / ≤5 (lg) / setting (xl+).
  const gridVars = {
    '--cols-sm': Math.min(perRow, 2),
    '--cols-md': Math.min(perRow, 3),
    '--cols-lg': Math.min(perRow, 5),
    '--cols-xl': perRow,
  } as React.CSSProperties;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('home.title')}</h1>
      {rows.length === 0 && <p className="text-muted-foreground">{t('home.empty')}</p>}
      <div
        style={gridVars}
        className={cn(
          'grid grid-cols-1 items-start gap-4 sm:grid-cols-[repeat(var(--cols-sm),minmax(0,1fr))] md:grid-cols-[repeat(var(--cols-md),minmax(0,1fr))] lg:grid-cols-[repeat(var(--cols-lg),minmax(0,1fr))] xl:grid-cols-[repeat(var(--cols-xl),minmax(0,1fr))]',
          perRow === 1 && 'mx-auto max-w-xl',
        )}
      >
        {rows.map(({ event, venue, cover }) => {
          const state = computeSaleState(event);
          const price = fromPrice.get(event.id);
          return (
            <Card key={event.id} className="flex flex-col overflow-hidden">
              {cover?.id && (
                <Link
                  href={`/events/${event.slug}`}
                  tabIndex={-1}
                  aria-hidden
                  className="-mt-6 block overflow-hidden bg-muted"
                  style={{ aspectRatio: coverAspect(cover.width, cover.height) }}
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
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg">{L(event, 'title', event.title)}</CardTitle>
                  <Badge variant={state === 'ON_SALE' ? 'default' : 'secondary'}>
                    {t(`saleState.${state}`)}
                  </Badge>
                </div>
                {event.subtitle && (
                  <p className="text-sm text-muted-foreground">
                    {L(event, 'subtitle', event.subtitle)}
                  </p>
                )}
              </CardHeader>
              <CardContent className="flex-1 space-y-1 text-sm text-muted-foreground">
                <p className="flex items-center gap-2">
                  <CalendarDays className="size-4" />
                  {format.dateTime(event.startsAt, {
                    dateStyle: 'full',
                    timeStyle: 'short',
                    timeZone: event.timeZone,
                  })}
                </p>
                <p className="flex items-center gap-2">
                  <MapPin className="size-4" />
                  {[L(venue, 'name', venue.name), venue.city].filter(Boolean).join(', ')}
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
              <CardFooter>
                <Button
                  asChild
                  className="w-full"
                  variant={state === 'ON_SALE' || state === 'PRESALE' ? 'default' : 'outline'}
                >
                  <Link href={`/events/${event.slug}`}>{t('home.tickets')}</Link>
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
