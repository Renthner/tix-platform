import { getSetting, listWaitlistEntries } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EventSalesForm } from '@/components/admin/event-forms';
import { WaitlistAdmin } from '@/components/admin/waitlist-admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { utcToZonedWallTime } from '@/lib/datetime';
import { requireAdmin } from '@/server/auth';
import { updateEventSalesAction } from '@/server/admin/events';
import { getEventWithVenue } from '@/server/admin/queries';
import { getCore } from '@/server/core';
import { notifyWaitlistNowAction, removeWaitlistEntryAction } from '@/server/admin/waitlist';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('sales') };
}

export default async function EventSalesPage({
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
  const [t, checkout, paypal, bank, accounts, waitlist, waitlistRows, selfService] =
    await Promise.all([
      getTranslations('admin.events.sales'),
      getSetting(getCore(), 'checkout'),
      getSetting(getCore(), 'paypal'),
      getSetting(getCore(), 'bankTransfer'),
      getSetting(getCore(), 'customerAccounts'),
      getSetting(getCore(), 'waitlist'),
      listWaitlistEntries(getCore(), id),
      getSetting(getCore(), 'ticketSelfService'),
    ]);
  const tz = event.timeZone;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <EventSalesForm
            action={updateEventSalesAction.bind(null, event.id)}
            timeZone={tz}
            globals={{
              maxTicketsPerOrder: checkout.maxTicketsPerOrder,
              maxTicketsPerCustomer: checkout.maxTicketsPerCustomer,
              cartLockTtlSeconds: checkout.cartLockTtlSeconds,
              paymentGraceSeconds: checkout.paymentGraceSeconds,
              manualSeatSelectionEnabled: checkout.manualSeatSelectionEnabled,
              bestAvailableEnabled: checkout.bestAvailableEnabled,
              companionRequiresWheelchair: checkout.companionSeatsRequireWheelchair,
              paypalEnabled: paypal.enabled,
              bankTransferEnabled: bank.enabled,
              bankTransferPaymentTermDays: bank.paymentTermDays,
              bankTransferReminderAfterDays: bank.reminderAfterDays,
              bankTransferCancelAfterDays: bank.cancelAfterDays,
              bankTransferDisableDaysBeforeEvent: bank.disableDaysBeforeEvent,
              customerAccountsEnabled: accounts.enabled,
              waitlistEnabled: waitlist.enabled,
              waitlistTrigger: waitlist.trigger,
              selfService,
            }}
            initial={{
              presaleStartsAt: utcToZonedWallTime(event.presaleStartsAt, tz),
              publicSaleStartsAt: utcToZonedWallTime(event.publicSaleStartsAt, tz),
              saleEndsAt: utcToZonedWallTime(event.saleEndsAt, tz),
              salesPaused: event.salesPaused,
              maxTicketsPerOrder: event.maxTicketsPerOrder,
              maxTicketsPerCustomer: event.maxTicketsPerCustomer,
              cartLockTtlSeconds: event.cartLockTtlSeconds,
              paymentGraceSeconds: event.paymentGraceSeconds,
              manualSeatSelectionEnabled: event.manualSeatSelectionEnabled,
              bestAvailableEnabled: event.bestAvailableEnabled,
              orphanSeatRuleEnabled: event.orphanSeatRuleEnabled ?? checkout.orphanSeatRuleEnabled,
              companionRequiresWheelchair: event.companionRequiresWheelchair,
              paypalEnabled: event.paypalEnabled,
              bankTransferEnabled: event.bankTransferEnabled,
              bankTransferPaymentTermDays: event.bankTransferPaymentTermDays,
              bankTransferReminderAfterDays: event.bankTransferReminderAfterDays,
              bankTransferCancelAfterDays: event.bankTransferCancelAfterDays,
              bankTransferAutoCancel: event.bankTransferAutoCancel,
              bankTransferDisableDaysBeforeEvent: event.bankTransferDisableDaysBeforeEvent,
              customerAccountsEnabled: event.customerAccountsEnabled,
              seoNoindex: event.seoNoindex,
              waitlistEnabled: event.waitlistEnabled,
              waitlistTrigger: event.waitlistTrigger,
              selfServiceEnabled: event.selfServiceEnabled,
              selfServiceAllowNameChange: event.selfServiceAllowNameChange,
              selfServiceAllowTransfer: event.selfServiceAllowTransfer,
              selfServiceDeadlineHours: event.selfServiceDeadlineHours,
              selfServiceMaxChanges: event.selfServiceMaxChanges,
            }}
          />
        </CardContent>
      </Card>
      <WaitlistAdmin
        eventId={event.id}
        notify={notifyWaitlistNowAction.bind(null, event.id)}
        rows={waitlistRows.map((r) => ({
          id: r.id,
          email: r.email,
          firstName: r.firstName,
          quantity: r.quantity,
          categoryName: r.categoryName,
          confirmed: r.confirmedAt !== null,
          createdAt: r.createdAt.toISOString(),
          lastNotifiedAt: r.lastNotifiedAt?.toISOString() ?? null,
          notifiedCount: r.notifiedCount,
          remove: removeWaitlistEntryAction.bind(null, event.id, r.id),
        }))}
      />
    </div>
  );
}
