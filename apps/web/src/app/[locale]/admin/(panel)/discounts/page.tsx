import { getSetting, listDiscountCodes } from '@tix/core';
import { events, priceCategories, ticketTypes } from '@tix/db';
import { buildQuery, formatHundredths, parsePage, parsePageSize } from '@tix/shared';
import { asc } from 'drizzle-orm';
import { Download, Plus, TicketPercent } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { DetailSection } from '@/components/admin/detail-layout';
import { DiscountForm } from '@/components/admin/discount-forms';
import { EmptyState } from '@/components/admin/empty-state';
import { ListToolbar, type ActiveFilterChip } from '@/components/admin/list-toolbar';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Badge } from '@/components/ui/badge';
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
import { saveDiscountCodeAction } from '@/server/admin/discounts';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('discounts');
  return { title: t('title') };
}

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

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
  const pageSize = parsePageSize(sp.pageSize, PAGE_SIZES, DEFAULT_PAGE_SIZE);
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const batch = sp.batch && /^[0-9a-f-]{36}$/i.test(sp.batch) ? sp.batch : undefined;
  const core = getCore();
  const [t, tl, format, general, checkout, list, eventRows, categories, tariffs] =
    await Promise.all([
      getTranslations('discounts'),
      getTranslations('admin.list'),
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

  const base = '/admin/discounts';
  const keptPageSize = pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined;
  const listParams = { q, batch, pageSize: keptPageSize };
  const chips: ActiveFilterChip[] = [];
  if (q) {
    chips.push({
      key: 'q',
      label: tl('searchChip', { value: q }),
      removeHref: buildQuery(base, listParams, { q: undefined }),
    });
  }
  if (batch) {
    chips.push({
      key: 'batch',
      label: t('batchTitle'),
      removeHref: buildQuery(base, listParams, { batch: undefined }),
    });
  }
  const resetHref = chips.length > 0 ? buildQuery(base, { pageSize: keptPageSize }) : null;

  return (
    <>
      <AdminPageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button asChild variant="outline">
              <a
                href={`/api/admin/discounts/export?locale=${locale}${batch ? `&batch=${batch}` : ''}`}
                data-testid="discounts-export"
              >
                <Download /> {batch ? t('exportBatch') : t('exportCsv')}
              </a>
            </Button>
            <Button asChild>
              <a href="#create" data-testid="discounts-new">
                <Plus /> {t('createTitle')}
              </a>
            </Button>
          </>
        }
      />
      <div className="space-y-6 p-6">
        <div className="space-y-4">
          <ListToolbar
            data-testid="discounts-toolbar"
            search={{ value: q, placeholder: t('search') }}
            hidden={{ batch, pageSize: keptPageSize }}
            resetHref={resetHref}
            chips={chips}
          />
          {batch && <p className="text-sm text-muted-foreground">{t('batchHint')}</p>}
          <Card>
            <CardContent className={list.items.length === 0 ? undefined : 'p-0'}>
              {list.items.length === 0 ? (
                <EmptyState
                  icon={TicketPercent}
                  title={t('empty')}
                  description={resetHref ? tl('emptyFiltered') : undefined}
                  action={
                    resetHref ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={resetHref}>{tl('reset')}</Link>
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
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
                        <TableCell className="text-xs whitespace-nowrap">
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
              )}
            </CardContent>
          </Card>
          <AdminPagination
            pathname={base}
            params={{ q, batch }}
            page={page}
            total={list.total}
            pageSize={pageSize}
            pageSizes={PAGE_SIZES}
            defaultPageSize={DEFAULT_PAGE_SIZE}
            summary={t('listTitle', { count: list.total })}
          />
        </div>
        {/* Target of the "+ New → Discount code" entry in the top bar and the header button. */}
        <section id="create" className="scroll-mt-4">
          <DetailSection title={t('createTitle')} data-testid="discount-create">
            <DiscountForm
              action={saveDiscountCodeAction.bind(null, null)}
              options={{ events: eventRows, categories, tariffs }}
              timeZone={general.defaultTimeZone}
              currency={general.defaultCurrency}
              policy={checkout}
            />
          </DetailSection>
        </section>
      </div>
    </>
  );
}
