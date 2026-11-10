/**
 * Result of banking server actions. Codes are translated in the UI via the `banking`
 * namespace (`banking.errors.field.*`, `banking.errors.form.*`, `banking.messages.*`).
 */
export const BANKING_FIELD_ERRORS = [
  'required',
  'invalid',
  'tooLong',
  'tooSmall',
  'tooLarge',
  'iban',
  'ibanTaken',
  'bic',
  'bankCode',
  'url',
  'pollInterval',
  'tan',
  'amount',
] as const;
export type BankingFieldError = (typeof BANKING_FIELD_ERRORS)[number];

export const BANKING_FORM_ERRORS = [
  'generic',
  'notFound',
  'busy',
  'inactive',
  'notPolling',
  'hasTransactions',
  'tanNotPending',
  'orderNotPayable',
  'orderNotFound',
  'currencyMismatch',
  'amountExceeds',
  'resolved',
  'hasAllocations',
  'notCredit',
  'notSupported',
  'provider',
  'imap',
  'noCredentials',
  'alreadyReversed',
  'reversalBlockedRefunds',
  'reversalBlockedCheckedIn',
  'reversalBlockedState',
  'reversalBlockedPaypalOrder',
  'reversalBlockedEventStarted',
  'reversalBlockedAdjustment',
  'adjustmentAmount',
] as const;
export type BankingFormError = (typeof BANKING_FORM_ERRORS)[number];

export const BANKING_MESSAGES = [
  'saved',
  'created',
  'deleted',
  'syncQueued',
  'tanSent',
  'approvalSent',
  'tanCancelled',
  'assignedPaid',
  'assignedPartial',
  'assignedOverpaid',
  'assignedAlreadyPaid',
  'ignored',
  'rematched',
  'webFormReady',
  'upToDate',
  'refreshed',
  'imapOk',
  'reversed',
  'reversedReopened',
] as const;
export type BankingMessage = (typeof BANKING_MESSAGES)[number];

export type BankingActionState =
  | { status: 'idle' }
  | {
      status: 'success';
      message: BankingMessage;
      /** Amounts in cents / counts used as message placeholders. */
      values?: Record<string, number | string>;
      /** External link to open (finAPI web form). */
      url?: string;
      at: number;
    }
  | {
      status: 'error';
      fieldErrors?: Partial<Record<string, BankingFieldError>>;
      formError?: BankingFormError;
      /** Untranslated detail from the bank / provider. */
      detail?: string;
      values?: Record<string, number | string>;
      at: number;
    };

export const BANKING_IDLE: BankingActionState = { status: 'idle' };
