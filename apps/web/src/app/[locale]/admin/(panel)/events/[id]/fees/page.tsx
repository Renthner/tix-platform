import { getEventFees, listTaxRatesWithUsage, type FeeRow } from '@tix/core';
import { priceCategories } from '@tix/db';
import { and, eq, min } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EventFeesManager, type FeeView } from '@/components/admin/fees-manager';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import {
  deleteEventFeeAction,
  resetEventFeeAction,
  saveEventFeeAction,
  saveEventFeeOverrideAction,
  waiveEventFeeAction,
} from '@/server/admin/fees';
import { getEventWithVenue } from '@/server/admin/queries';
import { getCore } from '@/server/core';

/** Example ticket price when the event has no price category yet (cents). */
const FALLBACK_EXAMPLE_PRICE = 3000;

export async function generateMetadata() {
  const t = await getTranslations('fees');
  return { title: t('tab') };
}

const view = (f: FeeRow): FeeView => ({
  id: f.id,
  name: f.name,
  scope: f.scope,
  calculation: f.calculation,
  value: f.value,
  taxRateId: f.taxRateId,
  paymentMethods: f.paymentMethods,
  channels: f.channels,
  isActive: f.isActive,
  sortOrder: f.sortOrder,
});

export default async function EventFeesPage({
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
  const { db } = getCore();
  const [fees, taxRates, [cheapest]] = await Promise.all([
    getEventFees(db, event.id),
    listTaxRatesWithUsage(db),
    db
      .select({ price: min(priceCategories.basePrice) })
      .from(priceCategories)
      .where(and(eq(priceCategories.eventId, event.id), eq(priceCategories.isActive, true))),
  ]);
  const eventRate = taxRates.find((r) => r.id === fees.eventTaxRateId);

  return (
    <EventFeesManager
      currency={fees.currency}
      defaultTicketPrice={cheapest?.price ?? FALLBACK_EXAMPLE_PRICE}
      eventTaxRateName={eventRate?.name ?? '–'}
      taxRates={taxRates.map((r) => ({
        id: r.id,
        name: r.name,
        rateBasisPoints: r.rateBasisPoints,
        isActive: r.isActive,
      }))}
      globals={fees.globals.map((g) => ({
        global: view(g.global),
        override: g.override ? view(g.override) : null,
        state: g.state,
        effective: view(g.effective),
        charged: g.charged,
        adjust: saveEventFeeOverrideAction.bind(null, event.id, g.global.id),
        waive: waiveEventFeeAction.bind(null, event.id, g.global.id),
        reset: resetEventFeeAction.bind(null, event.id, g.global.id),
      }))}
      orderFees={fees.orderFees.map(view)}
      own={fees.own.map((f) => ({
        ...view(f),
        save: saveEventFeeAction.bind(null, event.id, f.id),
        remove: deleteEventFeeAction.bind(null, event.id, f.id),
      }))}
      createOwn={saveEventFeeAction.bind(null, event.id, null)}
    />
  );
}
