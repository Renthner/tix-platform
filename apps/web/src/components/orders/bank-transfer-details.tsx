import { buildEpcPayload, epcQrSvg, type BankDetailsModel } from '@tix/core';
import { CopyValue } from '@/components/shop/order-actions';

export const groupIban = (iban: string) => iban.replace(/(.{4})(?=.)/g, '$1 ');

/**
 * Bank transfer instructions (amount, reference, receiving account) – shared by order and
 * adjustment. Shows an EPC QR code ("GiroCode") when the data can be expressed in one.
 */
export function BankTransferDetails({
  bank,
  amountText,
  amountCents,
  currency,
  reference,
  labels,
}: {
  bank: BankDetailsModel;
  amountText: string;
  amountCents: number;
  /** Order currency: the EPC QR code is only offered for EUR. */
  currency: string;
  reference: string;
  labels: {
    amount: string;
    reference: string;
    holder: string;
    bank: string;
    /** Accessible name of the QR code image. */
    epcQrLabel: string;
    epcTitle?: string;
    epcHint?: string;
  };
}) {
  const epc = buildEpcPayload({
    name: bank.holder,
    iban: bank.iban,
    bic: bank.bic,
    amountCents,
    currency,
    reference,
  });
  return (
    <div className="space-y-4">
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
      {epc && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border p-3">
          <div
            role="img"
            aria-label={labels.epcQrLabel}
            data-testid="epc-qr"
            className="size-36 shrink-0 overflow-hidden rounded bg-white [&>svg]:size-full"
            // Generated from our own data by qrcode-generator (numeric path only).
            dangerouslySetInnerHTML={{ __html: epcQrSvg(epc) }}
          />
          <div className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
            {labels.epcTitle && <p className="font-medium">{labels.epcTitle}</p>}
            {labels.epcHint && <p className="text-xs text-muted-foreground">{labels.epcHint}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
