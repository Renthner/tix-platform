import type { BankStatementFormat } from '@tix/shared';

/**
 * Source-independent representation of one booked transaction. Every adapter (CAMT, MT940,
 * CSV, FinTS, finAPI) produces this shape, so fingerprints – and therefore duplicate
 * detection across sources – are computed identically.
 */
export interface ParsedTransaction {
  /** ISO date (YYYY-MM-DD). */
  bookingDate: string;
  valueDate?: string | null;
  /** Signed cents: credits > 0, debits < 0. */
  amount: number;
  /** ISO 4217, upper case. */
  currency: string;
  counterpartyName?: string | null;
  counterpartyIban?: string | null;
  counterpartyBic?: string | null;
  /** Unstructured remittance information (Verwendungszweck). */
  remittanceInformation?: string | null;
  endToEndId?: string | null;
  /** Bank-side reference (camt AcctSvcrRef, MT940 bank reference, provider transaction id). */
  externalId?: string | null;
  /** German GVC / ISO bank transaction code. */
  bankTransactionCode?: string | null;
  /** Booking text (e.g. "GUTSCHRIFT"), kept for display. */
  bookingText?: string | null;
  /** Source-specific extra fields stored as raw_data. */
  raw?: Record<string, unknown>;
}

export interface ParsedStatement {
  /** Statement identification (camt Stmt/Id, MT940 :20: / :28C:). */
  statementId?: string | null;
  /** Account the file belongs to (IBAN or `BLZ/account`). */
  accountIdentifier?: string | null;
  currency?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  transactions: ParsedTransaction[];
}

export interface ParsedStatementFile {
  format: BankStatementFormat;
  statements: ParsedStatement[];
  /** Non-fatal issues (skipped lines, pending entries …). */
  warnings: string[];
}

export class StatementParseError extends Error {
  override name = 'StatementParseError';
  constructor(
    readonly code:
      | 'UNSUPPORTED_FORMAT'
      | 'INVALID_XML'
      | 'INVALID_MT940'
      | 'INVALID_CSV'
      | 'CSV_COLUMNS'
      | 'INVALID_ZIP'
      | 'EMPTY_FILE',
    message: string,
  ) {
    super(message);
  }
}
