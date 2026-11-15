import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/money';
import type { FeeView, GlobalFeeRowView, TaxRateOption } from './types';

// ─── Formatting helpers ─────────────────────────────────────────────────────

export function useFeeFormat(currency: string) {
  const t = useTranslations('fees');
  const locale = useLocale();
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const percent = (bp: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
      bp / 10_000,
    );
  const describe = (fee: Pick<FeeView, 'scope' | 'calculation' | 'value'>) =>
    t(`describe.${fee.scope}.${fee.calculation}`, {
      amount: money(fee.value),
      percent: percent(fee.value),
    });
  const appliesTo = (fee: Pick<FeeView, 'paymentMethods' | 'channels'>) => [
    fee.paymentMethods
      ? fee.paymentMethods.map((m) => t(`methods.${m}`)).join(', ')
      : t('allMethods'),
    (fee.channels?.length ? fee.channels : (['ONLINE'] as const))
      .map((c) => t(`channelNames.${c}`))
      .join(', '),
  ];
  return { money, percent, describe, appliesTo };
}

export function taxRateLabel(
  taxRateId: string | null,
  taxRates: TaxRateOption[],
  eventRate: string,
  percent: (bp: number) => string,
): string {
  if (!taxRateId) return eventRate;
  const rate = taxRates.find((r) => r.id === taxRateId);
  return rate ? `${rate.name} (${percent(rate.rateBasisPoints)})` : '–';
}

export function adjustmentSummary(
  fee: Pick<GlobalFeeRowView, 'overrideCount' | 'waivedCount'>,
  t: ReturnType<typeof useTranslations<'fees'>>,
): string {
  const parts = [
    fee.overrideCount > 0 ? t('global.adjusted', { count: fee.overrideCount }) : null,
    fee.waivedCount > 0 ? t('global.waived', { count: fee.waivedCount }) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '–';
}
