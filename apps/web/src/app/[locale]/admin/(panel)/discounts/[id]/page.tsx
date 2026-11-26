import { getDiscountCode, getSetting, listDiscountUsages } from '@tix/core';
import { events, priceCategories, ticketTypes } from '@tix/db';
import { formatHundredths } from '@tix/shared';
import { asc } from 'drizzle-orm';
import { Receipt, Trash2 } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { DiscountForm } from '@/components/admin/discount-forms';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminPageHeader } from '@/components/admin/page-header';
import { Badge } from '@/components/ui/badge';
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
import { utcToZonedWallTime } from '@/lib/datetime';
import {
  deleteDiscountCodeAction,
  saveDiscountCodeAction,
  setDiscountCodeActiveAction,
} from '@/server/admin/discounts';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('discounts');
  return { title: t('title') };
}

export default async function DiscountDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER', 'FINANCE']);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const core = getCore();
  const code = await getDiscountCode(core.db, id);
  if (!code) notFound();
  const [t, format, general, checkout, usages, eventRows, categories, tariffs] = await Promise.all([
    getTranslations('discounts'),
    getFormatter(),
    getSetting(core, 'general'),
    getSetting(core, 'checkout'),
    listDiscountUsages(core.db, id),
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
  const zone = general.defaultTimeZone;
  const date = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: 'short', timeStyle: 'short', timeZone: zone }) : '–';
  const dl = 'grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm';
  const dt = 'text-muted-foreground';

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[{ label: t('title'), href: '/admin/discounts' }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{code.code}</span>
            <Badge variant={code.status === 'ACTIVE' ? 'default' : 'secondary'}>
              {t(`status.${code.status}`)}
            </Badge>
          </span>
        }
        description={t('usage.stats', { uses: code.uses, amount: money(code.discountSum) })}
        actions={
          <>
            <ConfirmAction
              action={setDiscountCodeActiveAction.bind(null, code.id, !code.isActive)}
              variant="secondary"
              size="default"
              title={code.isActive ? t('deactivateTitle') : t('activateTitle')}
              description={code.code}
              confirmLabel={code.isActive ? t('deactivate') : t('activate')}
            >
              {code.isActive ? t('deactivate') : t('activate')}
            </ConfirmAction>
            <ConfirmAction
              action={deleteDiscountCodeAction.bind(null, code.id)}
              size="default"
              title={t('deleteTitle')}
              description={t('deleteHint')}
              confirmLabel={t('delete')}
              disabled={usages.total > 0}
            >
              <Trash2 /> {t('delete')}
            </ConfirmAction>
          </>
        }
      />
      <DetailLayout
        aside={
          <DetailSection title={t('overview')} data-testid="discount-overview">
            <dl className={dl}>
              <dt className={dt}>{t('columns.status')}</dt>
              <dd>{t(`status.${code.status}`)}</dd>
              <dt className={dt}>{t('columns.discount')}</dt>
              <dd className="tabular-nums">
                {code.type === 'PERCENT'
                  ? `${formatHundredths(code.value, 'percent')} %`
                  : money(code.value)}
              </dd>
              <dt className={dt}>{t('columns.scope')}</dt>
              <dd>
                {code.allEvents ? t('scopeAll') : t('scopeSome', { count: code.eventIds.length })}
              </dd>
              <dt className={dt}>{t('columns.validity')}</dt>
              <dd>
                {date(code.validFrom)} – {date(code.validUntil)}
              </dd>
              <dt className={dt}>{t('columns.uses')}</dt>
              <dd className="tabular-nums">
                {code.uses} / {code.maxTotalUses ?? '∞'}
              </dd>
              <dt className={dt}>{t('columns.total')}</dt>
              <dd className="tabular-nums">{money(code.discountSum)}</dd>
            </dl>
            {code.note && (
              <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">{code.note}</p>
            )}
          </DetailSection>
        }
      >
        <DetailSection title={t('detail')}>
          <DiscountForm
            action={saveDiscountCodeAction.bind(null, code.id)}
            options={{ events: eventRows, categories, tariffs }}
            timeZone={zone}
            currency={general.defaultCurrency}
            policy={checkout}
            initial={{
              code: code.code,
              type: code.type,
              value: code.value,
              allEvents: code.allEvents,
              eventIds: code.eventIds,
              categoryIds: code.categoryIds,
              ticketTypeIds: code.ticketTypeIds,
              validFrom: utcToZonedWallTime(code.validFrom, zone),
              validUntil: utcToZonedWallTime(code.validUntil, zone),
              maxTotalUses: code.maxTotalUses,
              maxUsesPerEmail: code.maxUsesPerEmail,
              minOrderValue: code.minOrderValue,
              discountFees: code.discountFees,
              stackable: code.stackable,
              isActive: code.isActive,
              note: code.note ?? '',
            }}
          />
        </DetailSection>
        <DetailSection
          title={t('usage.title')}
          contentClassName={usages.rows.length === 0 ? undefined : 'p-0'}
          data-testid="discount-usage"
        >
          {usages.rows.length === 0 ? (
            <EmptyState icon={Receipt} size="sm" title={t('usage.empty')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('usage.order')}</TableHead>
                  <TableHead>{t('usage.customer')}</TableHead>
                  <TableHead>{t('usage.status')}</TableHead>
                  <TableHead className="text-right">{t('usage.discount')}</TableHead>
                  <TableHead>{t('usage.date')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usages.rows.map((u) => (
                  <TableRow key={u.orderId} className={u.counted ? undefined : 'opacity-60'}>
                    <TableCell>
                      <Link href={`/admin/orders/${u.orderId}`} className="hover:underline">
                        {u.orderNumber}
                      </Link>
                      {u.isTest && (
                        <Badge variant="outline" className="ml-2">
                          {t('usage.test')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{u.email ?? '–'}</TableCell>
                    <TableCell
                      className="text-xs"
                      title={u.counted ? undefined : t('usage.notCounted')}
                    >
                      {u.status}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(u.amount)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{date(u.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DetailSection>
      </DetailLayout>
    </>
  );
}
