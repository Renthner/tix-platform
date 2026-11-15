import { getSetting, listDiscountCodes } from '@tix/core';
import { events, priceCategories, ticketTypes } from '@tix/db';
import { formatHundredths, parsePage, parsePageSize } from '@tix/shared';
import { asc } from 'drizzle-orm';
import { Search } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { DiscountForm } from '@/components/admin/discount-forms';
import { PageHeader } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
import { saveDiscountCodeAction } from '@/server/admin/discounts';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('discounts');
  return { title: t('title') };
}

const PAGE_SIZES = [25, 50, 100] as const;

export default async function DiscountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const locale = await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER', 'FINANCE']);
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const pageSize = parsePageSize(sp.pageSize, PAGE_SIZES, 50);
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const batch = sp.batch && /^[0-9a-f-]{36}$/i.test(sp.batch) ? sp.batch : undefined;
  const core = getCore();
  const [t, format, general, checkout, list, eventRows, categories, tariffs] = await Promise.all([
    getTranslations('discounts'),
    getFormatter(),
    getSetting(core, 'general'),
    getSetting(core, 'checkout'),
    listDiscountCodes(core.db, { q, batchId: batch, page, pageSize }),
    core.db
      .select({ id: events.id, title: events.title })
      .from(events)
      .orderBy(asc(events.startsAt)),
    core.db
      .select({
        id: priceCategories.id,
        name: priceCategories.name,
        eventId: priceCategories.eventId,
      })
      .from(priceCategories)
      .orderBy(asc(priceCategories.sortOrder)),
    core.db
      .select({ id: ticketTypes.id, name: ticketTypes.name, eventId: ticketTypes.eventId })
      .from(ticketTypes)
      .orderBy(asc(ticketTypes.sortOrder)),
  ]);
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: general.defaultCurrency });
  const date = (d: Date | null) =>
    d
      ? format.dateTime(d, {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: general.defaultTimeZone,
        })
      : '–';

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild variant="outline">
            <a
              href={`/api/admin/discounts/export?locale=${locale}${batch ? `&batch=${batch}` : ''}`}
            >
              {batch ? t('exportBatch') : t('exportCsv')}
            </a>
          </Button>
        }
      />
      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('createTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DiscountForm
              action={saveDiscountCodeAction.bind(null, null)}
              options={{ events: eventRows, categories, tariffs }}
              timeZone={general.defaultTimeZone}
              currency={general.defaultCurrency}
              policy={checkout}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{batch ? t('batchTitle') : t('listTitle', { count: list.total })}</CardTitle>
            {batch && (
              <p className="text-sm text-muted-foreground">
                {t('batchHint')}{' '}
                <Link href="/admin/discounts" className="underline">
                  {t('clearBatch')}
                </Link>
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <form className="flex gap-2" method="get">
              {batch && <input type="hidden" name="batch" value={batch} />}
              <Input name="q" defaultValue={q} placeholder={t('search')} className="max-w-xs" />
              <Button type="submit" variant="secondary" size="icon" aria-label={t('search')}>
                <Search className="size-4" />
              </Button>
            </form>
            {list.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('columns.code')}</TableHead>
                      <TableHead>{t('columns.discount')}</TableHead>
                      <TableHead>{t('columns.scope')}</TableHead>
                      <TableHead>{t('columns.validity')}</TableHead>
                      <TableHead className="text-right">{t('columns.uses')}</TableHead>
                      <TableHead className="text-right">{t('columns.total')}</TableHead>
                      <TableHead>{t('columns.status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.items.map((c) => (
                      <TableRow key={c.id} className={c.isActive ? undefined : 'opacity-60'}>
                        <TableCell>
                          <Link
                            href={`/admin/discounts/${c.id}`}
                            className="font-mono font-medium hover:underline"
                          >
                            {c.code}
                          </Link>
                          {c.note && (
                            <span className="block text-xs text-muted-foreground">{c.note}</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {c.type === 'PERCENT'
                            ? `${formatHundredths(c.value, 'percent')} %`
                            : money(c.value)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {c.allEvents
                            ? t('scopeAll')
                            : t('scopeSome', { count: c.eventIds.length })}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {date(c.validFrom)} – {date(c.validUntil)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.uses} / {c.maxTotalUses ?? '∞'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(c.discountSum)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={c.status === 'ACTIVE' ? 'default' : 'secondary'}>
                            {t(`status.${c.status}`)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <AdminPagination
              pathname="/admin/discounts"
              params={{ q, batch }}
              page={page}
              total={list.total}
              pageSize={pageSize}
              pageSizes={PAGE_SIZES}
              defaultPageSize={50}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
