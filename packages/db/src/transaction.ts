import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from './client';
import { isTransientTransactionError } from './errors';
import { numberSequences } from './schema';

export interface TransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  accessMode?: 'read only' | 'read write';
  /** Total attempts including the first one (serialization failures / deadlocks only). */
  maxAttempts?: number;
}

/**
 * Runs `fn` in an ACID transaction and transparently retries on serialization failures
 * (40001) and deadlocks (40P01) with jittered exponential backoff.
 *
 * `fn` may run more than once: it must not perform irreversible side effects outside the
 * database (enqueue jobs / publish events *after* the transaction commits).
 */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(fn, {
        isolationLevel: options.isolationLevel ?? 'read committed',
        accessMode: options.accessMode ?? 'read write',
      });
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientTransactionError(err)) throw err;
      const base = 20 * 2 ** (attempt - 1);
      await sleep(base + Math.floor(Math.random() * base));
    }
  }
}

/**
 * Allocates the next value of a gapless counter (`number_sequences`).
 * Must be called inside the transaction that persists the numbered document: the row lock
 * taken by the UPSERT serialises concurrent allocations, and a rollback releases the
 * number again – so issued invoice numbers never have gaps (GoBD).
 */
export async function nextSequenceValue(tx: Executor, scope: string): Promise<number> {
  const [row] = await tx
    .insert(numberSequences)
    .values({ scope, lastValue: 1 })
    .onConflictDoUpdate({
      target: numberSequences.scope,
      set: { lastValue: sql`${numberSequences.lastValue} + 1`, updatedAt: sql`now()` },
    })
    .returning({ value: numberSequences.lastValue });
  if (!row) throw new Error(`Sequence allocation for "${scope}" returned no row`);
  return row.value;
}
