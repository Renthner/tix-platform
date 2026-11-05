import { computeSaleState } from '@tix/core';
import { events, priceCategories, venues } from '@tix/db';
import { and, asc, eq, gt, inArray, min } from 'drizzle-orm';
import { CalendarDays, MapPin } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('shop.home');
  return { title: t('title') };
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const { db } = getCore();
  const [t, format] = await Promise.all([getTranslations('shop'), getFormatter()]);
  const rows = await db
    .select({ event: events, venue: { name: venues.name, city: venues.city } })
    .from(events)
    .innerJoin(venues, eq(venues.id, events.venueId))
    .where(and(inArray(events.status, ['PUBLISHED', 'POSTPONED']), gt(events.startsAt, new Date())))
    .orderBy(asc(events.startsAt))
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('home.title')}</h1>
      {rows.length === 0 && <p className="text-muted-foreground">{t('home.empty')}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ event, venue }) => {
          const state = computeSaleState(event);
          const price = fromPrice.get(event.id);
          return (
            <Card key={event.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg">{event.title}</CardTitle>
                  <Badge variant={state === 'ON_SALE' ? 'default' : 'secondary'}>
                    {t(`saleState.${state}`)}
                  </Badge>
                </div>
                {event.subtitle && (
                  <p className="text-sm text-muted-foreground">{event.subtitle}</p>
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
                  {[venue.name, venue.city].filter(Boolean).join(', ')}
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
