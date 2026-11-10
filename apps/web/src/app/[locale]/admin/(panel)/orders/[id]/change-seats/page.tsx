import { getSetting } from '@tix/core';
import { events, orderItems, orders } from '@tix/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ArrowLeft } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/admin/form-controls';
import { SeatChangeEditor } from '@/components/admin/seat-change-editor';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('orders.admin.seatChange');
  return { title: t('title') };
}

const CHANGEABLE = ['PAID', 'PARTIALLY_REFUNDED', 'AWAITING_PAYMENT', 'PENDING'] as const;

export default async function ChangeSeatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const core = getCore();
  const [order] = await core.db
    .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
    .from(orders)
    .where(eq(orders.id, id));
  if (!order) notFound();
  const [t, format, seatDisplay] = await Promise.all([
    getTranslations('orders.admin.seatChange'),
    getFormatter(),
    getSetting(core, 'seatDisplay'),
  ]);
  const changeable = (CHANGEABLE as readonly string[]).includes(order.status);
  // Events of the order that still have movable seat items.
  const eventRows = changeable
    ? await core.db
        .selectDistinct({
          id: events.id,
          title: events.title,
          startsAt: events.startsAt,
          timeZone: events.timeZone,
        })
        .from(orderItems)
        .innerJoin(events, eq(events.id, orderItems.eventId))
        .where(
          and(
            eq(orderItems.orderId, id),
            eq(orderItems.kind, 'SEAT'),
            inArray(orderItems.status, ['PENDING', 'CONFIRMED']),
          ),
        )
        .orderBy(asc(events.startsAt))
    : [];
  const requested = (await searchParams).event;
  const selected =
    eventRows.find((e) => e.id === requested) ?? (eventRows.length === 1 ? eventRows[0] : null);

  return (
    <>
      <PageHeader
        title={t('heading', { number: order.orderNumber })}
        description={selected ? selected.title : t('description')}
        actions={
          <Button asChild variant="outline">
            <Link href={`/admin/orders/${id}`}>
              <ArrowLeft /> {t('back')}
            </Link>
          </Button>
        }
      />
      <div className="p-6">
        {!changeable || eventRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noItems')}</p>
        ) : selected ? (
          <SeatChangeEditor orderId={id} eventId={selected.id} colors={seatDisplay} />
        ) : (
          <div className="max-w-xl space-y-2">
            <p className="text-sm text-muted-foreground">{t('chooseEvent')}</p>
            {eventRows.map((e) => (
              <Button key={e.id} asChild variant="outline" className="w-full justify-start">
                <Link href={`/admin/orders/${id}/change-seats?event=${e.id}`}>
                  {e.title} ·{' '}
                  {format.dateTime(e.startsAt, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: e.timeZone,
                  })}
                </Link>
              </Button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
