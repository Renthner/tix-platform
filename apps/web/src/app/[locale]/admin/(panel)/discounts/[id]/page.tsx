import { getDiscountCode, getSetting, listDiscountUsages } from '@tix/core';
import { events, priceCategories, ticketTypes } from '@tix/db';
import { asc } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { DiscountForm } from '@/components/admin/discount-forms';
import { PageHeader } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
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
  const [t, format, general, usages, eventRows, categories, tariffs] = await Promise.all([
    getTranslations('discounts'),
    getFormatter(),
    getSetting(core, 'general'),
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

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{code.code}</span>}
        description={t('usage.stats', { uses: code.uses, amount: money(code.discountSum) })}
        actions={
          <>
            <ConfirmAction
              action={setDiscountCodeActiveAction.bind(null, code.id, !code.isActive)}
              variant="secondary"
              title={code.isActive ? t('deactivateTitle') : t('activateTitle')}
              description={code.code}
              confirmLabel={code.isActive ? t('deactivate') : t('activate')}
            >
              {code.isActive ? t('deactivate') : t('activate')}
            </ConfirmAction>
            <ConfirmAction
              action={deleteDiscountCodeAction.bind(null, code.id)}
              title={t('deleteTitle')}
              description={t('deleteHint')}
              confirmLabel={t('delete')}
              disabled={usages.total > 0}
            >
              {t('delete')}
            </ConfirmAction>
          </>
        }
      />
      <div className="space-y-6 p-6">
        <Link href="/admin/discounts" className="text-sm underline">
          {t('back')}
        </Link>
        <Card>
          <CardContent className="pt-6">
            <DiscountForm
              action={saveDiscountCodeAction.bind(null, code.id)}
              options={{ events: eventRows, categories, tariffs }}
              timeZone={zone}
              currency={general.defaultCurrency}
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('usage.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {usages.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('usage.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
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
                        <TableCell className="whitespace-nowrap text-xs">
                          {format.dateTime(u.createdAt, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                            timeZone: zone,
                          })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
