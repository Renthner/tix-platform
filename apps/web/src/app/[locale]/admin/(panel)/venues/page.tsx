import { MapPin, Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ActiveBadge } from '@/components/admin/badges';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminPageHeader } from '@/components/admin/page-header';
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
import { requireAdmin } from '@/server/auth';
import { listVenuesWithPlanCount } from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.venues');
  return { title: t('title') };
}

export default async function VenuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ deleted?: string }>;
}) {
  await resolveLocale(params);
  const { deleted } = await searchParams;
  await requireAdmin(['EVENT_MANAGER']);
  const [t, rows] = await Promise.all([getTranslations('admin.venues'), listVenuesWithPlanCount()]);
  return (
    <>
      <AdminPageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild>
            <Link href="/admin/venues/new">
              <Plus /> {t('new')}
            </Link>
          </Button>
        }
      />
      <div className="space-y-4 p-6">
        {deleted && (
          <Alert>
            <AlertDescription>{t('deletedNotice')}</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardContent>
            {rows.length === 0 ? (
              <EmptyState
                icon={MapPin}
                title={t('empty')}
                description={t('emptyDescription')}
                action={
                  <Button asChild size="sm">
                    <Link href="/admin/venues/new">
                      <Plus /> {t('new')}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.name')}</TableHead>
                    <TableHead>{t('columns.city')}</TableHead>
                    <TableHead className="text-right">{t('columns.plans')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((v) => (
                    <TableRow
                      key={v.id}
                      data-testid="venue-row"
                      className="relative cursor-pointer focus-within:bg-muted/50"
                    >
                      <TableCell className="font-medium">
                        <Link
                          href={`/admin/venues/${v.id}`}
                          className="outline-none after:absolute after:inset-0 hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                        >
                          {v.name}
                        </Link>
                      </TableCell>
                      <TableCell>{v.city ?? '–'}</TableCell>
                      <TableCell className="text-right tabular-nums">{v.plans}</TableCell>
                      <TableCell>
                        <ActiveBadge active={v.isActive} />
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
