import { priceCategories } from '@tix/db';
import { eq } from 'drizzle-orm';
import { PencilRuler } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getEventWithVenue, seatingSummary } from '@/server/admin/queries';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('seating') };
}

export default async function EventSeatingPage({
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
  const t = await getTranslations('admin.seating');

  if (!event.seatMapId) {
    return (
      <Alert>
        <AlertDescription>{t('noPlan')}</AlertDescription>
      </Alert>
    );
  }
  const [summary, categories] = await Promise.all([
    seatingSummary(event.seatMapId),
    getCore()
      .db.select({
        id: priceCategories.id,
        name: priceCategories.name,
        color: priceCategories.color,
      })
      .from(priceCategories)
      .where(eq(priceCategories.eventId, event.id)),
  ]);
  const byId = new Map(categories.map((c) => [c.id, c]));

  const stats: [string, number][] = [
    [t('seatsTotal'), summary.seatsTotal],
    [t('seatsBlocked'), summary.seatsBlocked],
    [t('seatsWithoutCategory'), summary.seatsWithoutCategory],
    [t('standingAreas'), summary.standingAreas],
    [t('standingCapacity'), summary.standingCapacity],
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Button asChild>
            <Link href={`/admin/seat-maps/${event.seatMapId}`}>
              <PencilRuler /> {t('openEditor')}
            </Link>
          </Button>
          {(summary.seatsWithoutCategory > 0 || summary.standingWithoutCategory > 0) && (
            <Alert variant="destructive">
              <AlertDescription>
                {t('missingCategories', {
                  seats: summary.seatsWithoutCategory,
                  areas: summary.standingWithoutCategory,
                })}
              </AlertDescription>
            </Alert>
          )}
          <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-lg border p-4">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('perCategory')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('category')}</TableHead>
                <TableHead className="text-right">{t('seats')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.perCategory.map((r) => {
                const category = r.categoryId ? byId.get(r.categoryId) : undefined;
                return (
                  <TableRow key={r.categoryId ?? 'none'}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {category && (
                          <span
                            className="size-3 rounded-full border"
                            style={{ backgroundColor: category.color }}
                            aria-hidden
                          />
                        )}
                        {category?.name ?? t('noCategory')}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.seats}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
