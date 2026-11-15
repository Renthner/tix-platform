export type BankTxHold = 'INTERIM' | 'POSSIBLE_DUPLICATE' | 'NO_BOOKING_DATE' | 'AGGREGATE';

/** Reads the hold marker the importer wrote into `raw_data` (see packages/core banking/holds). */
export function bankTxHold(rawData: unknown): BankTxHold | null {
  const hold =
    typeof rawData === 'object' && rawData !== null
      ? (rawData as Record<string, unknown>).hold
      : null;
  return hold === 'INTERIM' ||
    hold === 'POSSIBLE_DUPLICATE' ||
    hold === 'NO_BOOKING_DATE' ||
    hold === 'AGGREGATE'
    ? hold
    : null;
}

/** Holds an admin can release for matching ("not a duplicate"). */
export function isReleasableBankTxHold(hold: BankTxHold | null): boolean {
  return hold === 'POSSIBLE_DUPLICATE' || hold === 'NO_BOOKING_DATE';
}
