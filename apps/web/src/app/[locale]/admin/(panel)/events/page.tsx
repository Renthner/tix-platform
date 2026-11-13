import { computeSaleState } from '@tix/core';
import { EVENT_STATUSES, type EventStatus } from '@tix/shared';
import { ArrowUpDown, ImageIcon, Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { EventStatusBadge, SaleStateBadge } from '@/components/admin/badges';
import { EventDuplicateDialog } from '@/components/admin/event-duplicate-dialog';
import { PageHeader } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { formatInZone, utcToZonedWallTime } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { MediaThumb } from '@/components/media-image';
import { requireAdmin } from '@/server/auth';
import { duplicateEventAction } from '@/server/admin/events';
import { listEvents } from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.events');
  return { title: t('title') };
}

export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string; deleted?: string }>;
}) {
  const locale = await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { status, deleted } = await searchParams;
  const filter = (EVENT_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as EventStatus)
    : undefined;
  const [t, ts, rows] = await Promise.all([
    getTranslations('admin.events'),
    getTranslations('admin.eventStatus'),
    listEvents({ status: filter }),
  ]);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/admin/events/shop-order">
                <ArrowUpDown /> {t('shopOrder')}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/admin/events/new">
                <Plus /> {t('new')}
              </Link>
            </Button>
          </div>
        }
      />
      <div className="space-y-4 p-6">
        {deleted && (
          <Alert>
            <AlertDescription>{t('deletedNotice')}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2 text-sm">
          {[undefined, ...EVENT_STATUSES].map((s) => (
            <Link
              key={s ?? 'all'}
              href={s ? `/admin/events?status=${s}` : '/admin/events'}
              className={cn(
                'rounded-full border px-3 py-1',
                filter === s
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              {s ? ts(s) : t('filterAll')}
            </Link>
          ))}
        </div>
        <Card>
          <CardContent>
            {rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.title')}</TableHead>
                    <TableHead>{t('columns.date')}</TableHead>
                    <TableHead>{t('columns.venue')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                    <TableHead>{t('columns.sale')}</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ event, venueName }) => (
                    <TableRow
                      key={event.id}
                      data-testid="event-row"
                      className="relative cursor-pointer focus-within:bg-muted/50"
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-3">
                          <div
                            data-testid="event-cover-thumb"
                            className="flex h-10 w-16 shrink-0 items-center justify-center"
                          >
                            {event.heroImageAssetId ? (
                              // Original aspect ratio, scaled into the fixed slot (names stay aligned).
                              <MediaThumb
                                assetId={event.heroImageAssetId}
                                variantWidth={320}
                                alt=""
                                className="h-auto max-h-10 w-auto max-w-16 rounded"
                              />
                            ) : (
                              <span className="flex size-full items-center justify-center rounded bg-muted text-muted-foreground">
                                <ImageIcon className="size-4" aria-hidden />
                              </span>
                            )}
                          </div>
                          <Link
                            href={`/admin/events/${event.id}`}
                            className="outline-none after:absolute after:inset-0 hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                          >
                            {event.title}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatInZone(event.startsAt, event.timeZone, locale)}
                      </TableCell>
                      <TableCell>{venueName}</TableCell>
                      <TableCell>
                        <EventStatusBadge status={event.status} />
                      </TableCell>
                      <TableCell>
                        <SaleStateBadge state={computeSaleState(event)} />
                      </TableCell>
                      <TableCell>
                        <div className="relative z-10">
                          <EventDuplicateDialog
                            size="sm"
                            action={duplicateEventAction.bind(null, event.id)}
                            title={event.title}
                            startsAt={utcToZonedWallTime(event.startsAt, event.timeZone)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
