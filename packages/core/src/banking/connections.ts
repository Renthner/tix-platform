import { bankAccounts, bankConnections } from '@tix/db';
import {
  bankConnectionSecretsSchema,
  type BankConnectionSecrets,
  type BankAdapter,
} from '@tix/shared';
import { eq, sql } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';

export type BankConnectionRow = typeof bankConnections.$inferSelect;
export type BankAccountRow = typeof bankAccounts.$inferSelect;

/** Encryption context binding connection secrets to their row (prevents envelope swapping). */
export const connectionSecretContext = (connectionId: string) =>
  `bank_connections.credentials:${connectionId}`;

/** Error raised by adapters; `code` is shown (translated) in the Admin Portal. */
export class BankSyncError extends Error {
  override name = 'BankSyncError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function loadConnection(
  ctx: Pick<CoreContext, 'db'>,
  connectionId: string,
): Promise<{ connection: BankConnectionRow; account: BankAccountRow } | null> {
  const [row] = await ctx.db
    .select({ connection: bankConnections, account: bankAccounts })
    .from(bankConnections)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankConnections.bankAccountId))
    .where(eq(bankConnections.id, connectionId));
  return row ?? null;
}

export function decryptConnectionSecrets<A extends BankAdapter>(
  ctx: CoreContext,
  connection: Pick<BankConnectionRow, 'id' | 'credentialsEncrypted'>,
  adapter: A,
): Extract<BankConnectionSecrets, { adapter: A }> | null {
  if (!connection.credentialsEncrypted) return null;
  const secrets = requireCapability(ctx, 'secrets');
  const value = bankConnectionSecretsSchema.parse(
    secrets.decryptJson(connection.credentialsEncrypted, connectionSecretContext(connection.id)),
  );
  if (value.adapter !== adapter) {
    throw new DomainError('SECRETS_MISMATCH', 'Stored credentials belong to another adapter', 500);
  }
  return value as Extract<BankConnectionSecrets, { adapter: A }>;
}

export function encryptConnectionSecrets(
  ctx: CoreContext,
  connectionId: string,
  value: BankConnectionSecrets,
): string {
  const secrets = requireCapability(ctx, 'secrets');
  return secrets.encryptJson(
    bankConnectionSecretsSchema.parse(value),
    connectionSecretContext(connectionId),
  );
}

/** Shallow-merges keys into `bank_connections.state` (atomic JSONB concatenation). */
export async function patchConnectionState(
  ctx: Pick<CoreContext, 'db'>,
  connectionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await ctx.db
    .update(bankConnections)
    .set({
      state: sql`${bankConnections.state} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(bankConnections.id, connectionId));
}

export async function replaceConnectionState(
  ctx: Pick<CoreContext, 'db'>,
  connectionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await ctx.db
    .update(bankConnections)
    .set({ state, updatedAt: new Date() })
    .where(eq(bankConnections.id, connectionId));
}
