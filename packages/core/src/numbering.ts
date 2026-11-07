import { numberSequences, type Database, type Transaction } from '@tix/db';
import { sql } from 'drizzle-orm';

type Executor = Database | Transaction;

/**
 * Gapless sequential numbers from a pattern such as `RE-{YYYY}-{SEQ:6}` or `{YYYY}-{SEQ:6}`.
 * Tokens: {YYYY} {YY} {SEQ} {SEQ:n} (zero padded). The counter scope is the pattern with
 * the year resolved, so each year starts at 1 when the pattern contains a year token.
 * Call inside the transaction that persists the number – a rollback releases it again
 * (row lock on `number_sequences`), keeping invoice numbers gapless (GoBD).
 */
export async function nextNumber(
  db: Executor,
  kind: string,
  pattern: string,
  at: Date = new Date(),
  timeZone = 'Europe/Berlin',
): Promise<string> {
  const year = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(at);
  const resolved = pattern.replaceAll('{YYYY}', year).replaceAll('{YY}', year.slice(2));
  const scope = `${kind}:${resolved.replace(/\{SEQ(?::\d{1,2})?\}/g, '#')}`;
  const [row] = await db
    .insert(numberSequences)
    .values({ scope, lastValue: 1 })
    .onConflictDoUpdate({
      target: numberSequences.scope,
      set: { lastValue: sql`${numberSequences.lastValue} + 1`, updatedAt: sql`now()` },
    })
    .returning({ value: numberSequences.lastValue });
  const value = row!.value;
  return resolved.replace(/\{SEQ(?::(\d{1,2}))?\}/g, (_m, width?: string) =>
    String(value).padStart(width ? Number(width) : 1, '0'),
  );
}
