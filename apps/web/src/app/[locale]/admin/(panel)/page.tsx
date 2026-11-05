import { computeSaleState } from '@tix/core';
import { Building2, CalendarPlus, Hourglass } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { EventStatusBadge, SaleStateBadge } from '@/components/admin/badges';
import { PageHeader } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { formatInZone } from '@/lib/datetime';
import { requireAdmin } from '@/server/auth';
import { listEvents } from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.dashboard');
  return { title: t('title') };
}

export default async function AdminDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ denied?: string }>;
}) {
  const locale = await resolveLocale(params);
  const session = await requireAdmin();
  const { denied } = await searchParams;
  const [t, upcoming] = await Promise.all([
    getTranslations('admin.dashboard'),
    listEvents({ upcomingOnly: true }),
  ]);

  return (
    <>
      <PageHeader title={t('title')} description={t('welcome', { name: session.displayName })} />
      <div className="space-y-6 p-6">
        {denied && (
          <Alert variant="destructive">
            <AlertDescription>{t('denied')}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/admin/events/new">
              <CalendarPlus /> {t('links.newEvent')}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/venues">
              <Building2 /> {t('links.venues')}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/waiting-room">
              <Hourglass /> {t('links.waitingRoom')}
            </Link>
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t('upcoming')}</CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{t('noEvents')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.event')}</TableHead>
                    <TableHead>{t('columns.date')}</TableHead>
                    <TableHead>{t('columns.venue')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                    <TableHead>{t('columns.sale')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcoming.slice(0, 20).map(({ event, venueName }) => (
                    <TableRow key={event.id}>
                      <TableCell className="font-medium">
                        <Link href={`/admin/events/${event.id}`} className="hover:underline">
                          {event.title}
                        </Link>
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
