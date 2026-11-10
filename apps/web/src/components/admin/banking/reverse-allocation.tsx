'use client';

import { useTranslations } from 'next-intl';
import { Textarea } from '@/components/ui/textarea';
import { reverseAllocationAction } from '@/server/admin/banking-actions';
import { BankingConfirm } from './account-form';
import { BankField, bankingError } from './banking-ui';

/**
 * "Zuordnung aufheben" for one active bank allocation: reason (required) + a confirmation that
 * spells out the consequences (order awaits payment again, tickets void, credit note).
 */
export function ReverseAllocationButton({
  allocationId,
  orderNumber,
}: {
  allocationId: string;
  orderNumber: string;
}) {
  const t = useTranslations('banking.reverse');
  return (
    <BankingConfirm
      action={reverseAllocationAction.bind(null, allocationId)}
      title={t('title', { order: orderNumber })}
      description={
        <>
          {t('description')}
          <ul className="mt-2 list-disc space-y-1 pl-5 text-left">
            <li>{t('consequencePayment')}</li>
            <li>{t('consequenceOrder')}</li>
            <li>{t('consequenceTickets')}</li>
            <li>{t('consequenceCreditNote')}</li>
            <li>{t('consequenceTransaction')}</li>
          </ul>
        </>
      }
      confirmLabel={t('confirm')}
      fields={(state) => (
        <BankField
          label={t('reason')}
          htmlFor={`reverse-${allocationId}`}
          error={bankingError(state, 'reason')}
        >
          <Textarea
            id={`reverse-${allocationId}`}
            name="reason"
            rows={3}
            maxLength={1000}
            required
            placeholder={t('reasonPlaceholder')}
          />
        </BankField>
      )}
    >
      {t('button')}
    </BankingConfirm>
  );
}
