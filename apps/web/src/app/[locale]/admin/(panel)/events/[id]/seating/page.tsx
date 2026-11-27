import { listContingents } from '@tix/core';
import { orderItems, priceCategories, seatMaps, tickets, venues } from '@tix/db';
import { asc, count, eq } from 'drizzle-orm';
import { PencilRuler } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SeatPlanReplace } from '@/components/admin/seat-plan-replace';
import { ContingentsManager, EventSeatingCardBody } from '@/components/admin/event-seating';
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
import {
  changeEventSeatingAction,
  removeContingentAction,
  saveContingentAction,
} from '@/server/admin/event-seating';
import {
  getEventWithVenue,
  listAllTemplates,
  listTemplates,
  seatingSummary,
} from '@/server/admin/queries';
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
  const { event, venue } = row;
  const t = await getTranslations('admin.seating');

  // Another plan / seating mode can only be assigned while nothing references the current one.
  const db = getCore().db;
  const [templates, [items], [issued], venueRows, allTemplates, [plan]] = await Promise.all([
    event.venueId ? listTemplates(event.venueId) : Promise.resolve([]),
    db.select({ n: count() }).from(orderItems).where(eq(orderItems.eventId, event.id)),
    db.select({ n: count() }).from(tickets).where(eq(tickets.eventId, event.id)),
    db
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(eq(venues.isActive, true))
      .orderBy(asc(venues.name)),
    listAllTemplates(),
    event.seatMapId
      ? db
          .select({ clonedFromId: seatMaps.clonedFromId })
          .from(seatMaps)
          .where(eq(seatMaps.id, event.seatMapId))
      : Promise.resolve([]),
  ]);
  const replaceBlocked =
    event.status !== 'DRAFT' ? 'notDraft' : (items?.n ?? 0) + (issued?.n ?? 0) > 0 ? 'inUse' : null;
  const planName = plan?.clonedFromId
    ? (allTemplates.find((tpl) => tpl.id === plan.clonedFromId)?.name ?? null)
    : null;
  const seatingCard = (
    <Card>
      <CardHeader>
        <CardTitle>{t('mode.title')}</CardTitle>
        <CardDescription>{t('mode.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <EventSeatingCardBody
          action={changeEventSeatingAction.bind(null, event.id)}
          mode={event.seatingMode}
          venueId={event.venueId}
          venueName={venue?.name ?? null}
          planName={planName}
          venues={venueRows}
          templates={allTemplates}
          blocked={replaceBlocked}
        />
      </CardContent>
    </Card>
  );

  if (event.seatingMode === 'ADMISSION') {
    const [overview, categories] = await Promise.all([
      listContingents(getCore(), event.id),
      db
        .select({
          id: priceCategories.id,
          name: priceCategories.name,
          color: priceCategories.color,
        })
        .from(priceCategories)
        .where(eq(priceCategories.eventId, event.id))
        .orderBy(asc(priceCategories.sortOrder), asc(priceCategories.name)),
    ]);
    return (
      <div className="space-y-6">
        {seatingCard}
        <Card>
          <CardHeader>
            <CardTitle>{t('contingents.title')}</CardTitle>
            <CardDescription>{t('contingents.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ContingentsManager
              saveAction={saveContingentAction.bind(null, event.id)}
              removeActions={Object.fromEntries(
                overview.contingents.map((c) => [
                  c.id,
                  removeContingentAction.bind(null, event.id, c.id),
                ]),
              )}
              contingents={overview.contingents}
              categories={categories}
              entrances={overview.entrances}
            />
          </CardContent>
        </Card>
      </div>
    );
  }
  const replacePanel = (
    <Card>
      <CardContent className="pt-6">
        <SeatPlanReplace
          eventId={event.id}
          templates={templates.map((tpl) => ({ id: tpl.id, name: tpl.name, seats: tpl.seats }))}
          blocked={replaceBlocked}
        />
      </CardContent>
    </Card>
  );

  if (!event.seatMapId) {
    return (
      <div className="space-y-6">
        {seatingCard}
        <Alert>
          <AlertDescription>{t('noPlan')}</AlertDescription>
        </Alert>
        {replacePanel}
      </div>
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
      {seatingCard}
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
      {replacePanel}
    </div>
  );
}
