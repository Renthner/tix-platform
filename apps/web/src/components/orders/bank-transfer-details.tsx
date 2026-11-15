import type { BankDetailsModel } from '@tix/core';
import { CopyValue } from '@/components/shop/order-actions';

export const groupIban = (iban: string) => iban.replace(/(.{4})(?=.)/g, '$1 ');

/** Bank transfer instructions (amount, reference, receiving account) – shared by order and adjustment. */
export function BankTransferDetails({
  bank,
  amountText,
  amountCents,
  reference,
  labels,
}: {
  bank: BankDetailsModel;
  amountText: string;
  amountCents: number;
  reference: string;
  labels: { amount: string; reference: string; holder: string; bank: string };
}) {
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[180px_1fr]">
      <dt className="text-muted-foreground">{labels.amount}</dt>
      <dd>
        <CopyValue value={amountText} copyText={(amountCents / 100).toFixed(2)} strong />
      </dd>
      <dt className="text-muted-foreground">{labels.reference}</dt>
      <dd>
        <CopyValue value={reference} strong />
      </dd>
      <dt className="text-muted-foreground">{labels.holder}</dt>
      <dd>
        <CopyValue value={bank.holder} />
      </dd>
      <dt className="text-muted-foreground">IBAN</dt>
      <dd>
        <CopyValue value={groupIban(bank.iban)} copyText={bank.iban} mono />
      </dd>
      {bank.bic && (
        <>
          <dt className="text-muted-foreground">BIC</dt>
          <dd>
            <CopyValue value={bank.bic} mono />
          </dd>
        </>
      )}
      {bank.bankName && (
        <>
          <dt className="text-muted-foreground">{labels.bank}</dt>
          <dd>{bank.bankName}</dd>
        </>
      )}
    </dl>
  );
}
