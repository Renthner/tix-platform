import {
  formatDateTime,
  getEventById,
  type GuestListLabels,
  type OccupancyLabels,
  type ReportEventInfo,
} from '@tix/core';
import { CHECK_IN_STATES, TICKET_STATUSES } from '@tix/shared';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { getCore } from '@/server/core';

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/** Event + locale context shared by the report routes. */
export async function reportContext(eventId: string, requestedLocale: string | undefined) {
  const locale = hasLocale(routing.locales, requestedLocale)
    ? requestedLocale
    : routing.defaultLocale;
  const core = getCore();
  const [event, t] = await Promise.all([
    getEventById(core, eventId),
    getTranslations({ locale, namespace: 'scanners.checkIn.reports' }),
  ]);
  const info: ReportEventInfo = {
    title: event.title,
    dateLine: formatDateTime(event.startsAt, locale, event.timeZone),
    timeZone: event.timeZone,
    generatedAt: new Date(),
    locale,
  };
  return { core, event, t, info, locale };
}

export function guestListLabels(t: Translator): GuestListLabels {
  return {
    title: t('guestList.title'),
    name: t('columns.name'),
    orderNumber: t('columns.orderNumber'),
    category: t('columns.category'),
    tariff: t('columns.tariff'),
    block: t('columns.block'),
    row: t('columns.row'),
    seat: t('columns.seat'),
    ticketStatus: t('columns.ticketStatus'),
    checkIn: t('columns.checkIn'),
    checkInTime: t('columns.checkInTime'),
    ticketStatuses: Object.fromEntries(
      TICKET_STATUSES.map((s) => [s, t(`ticketStatuses.${s}`)]),
    ) as GuestListLabels['ticketStatuses'],
    checkInStates: Object.fromEntries(
      CHECK_IN_STATES.map((s) => [s, t(`checkInStates.${s}`)]),
    ) as GuestListLabels['checkInStates'],
    generated: t.raw('generated') as string,
    pageOf: t.raw('pageOf') as string,
    count: t.raw('guestList.count') as string,
  };
}

export function occupancyLabels(t: Translator): OccupancyLabels {
  return {
    title: t('occupancy.title'),
    generated: t.raw('generated') as string,
    pageOf: t.raw('pageOf') as string,
    section: t('columns.block'),
    row: t('columns.row'),
    seat: t('columns.seat'),
    holder: t('columns.holder'),
    status: t('columns.status'),
    statuses: {
      SOLD: t('occupancy.SOLD'),
      RESERVED: t('occupancy.RESERVED'),
      BLOCKED: t('occupancy.BLOCKED'),
      FREE: t('occupancy.FREE'),
    },
    standing: t.raw('occupancy.standing') as string,
    noOccupied: t('occupancy.noOccupied'),
    noSeats: t('occupancy.noSeats'),
    totals: t.raw('occupancy.totals') as string,
  };
}
