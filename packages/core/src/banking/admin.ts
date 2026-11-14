import { randomUUID } from 'node:crypto';
import {
  bankAccounts,
  bankConnections,
  bankTransactions,
  isUniqueViolation,
  withTransaction,
} from '@tix/db';
import {
  bankConnectionConfigSchema,
  bankConnectionSecretsSchema,
  isValidBic,
  isValidIban,
  normalizeBic,
  normalizeIban,
  type BankConnectionConfig,
  type BankConnectionSecrets,
  type SupportedBankAdapter,
} from '@tix/shared';
import { and, count, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { EndpointNotAllowedError } from '../backup/endpoint-guard';
import { DomainError, type CoreContext } from '../context';
import { assertBankEndpointAllowed, assertMailHostAllowed } from '../network/host-guard';
import { disconnectFinApi, type FinApiDeps } from './adapters/finapi';
import { finTsIdentity } from './adapters/fints';
import {
  decryptConnectionSecrets,
  encryptConnectionSecrets,
  type BankConnectionRow,
} from './connections';

/** Minimum polling intervals per adapter (seconds). */
export const MIN_POLL_INTERVAL: Record<SupportedBankAdapter, number> = {
  FINTS: 900,
  // PSD2: max. 4 accesses per day without the user → every 6 h when updates are triggered.
  PSD2_FINAPI: 6 * 3600,
  IMAP: 60,
  FILE_IMPORT: 60,
};

export const bankAccountInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  accountHolder: z.string().trim().min(1).max(140),
  iban: z
    .string()
    .transform(normalizeIban)
    .refine((v) => isValidIban(v), 'iban'),
  bic: z
    .string()
    .transform(normalizeBic)
    .refine((v) => v === '' || isValidBic(v), 'bic')
    .optional(),
  bankName: z.string().trim().max(140).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  isDefaultForBankTransfer: z.boolean(),
  isActive: z.boolean(),
});
export type BankAccountInput = z.input<typeof bankAccountInputSchema>;

/** Creates or updates a receiving account; only one account can be the default. */
export async function saveBankAccount(
  ctx: Pick<CoreContext, 'db'>,
  id: string | null,
  input: BankAccountInput,
): Promise<{ id: string }> {
  const data = bankAccountInputSchema.parse(input);
  const values = {
    name: data.name,
    accountHolder: data.accountHolder,
    iban: data.iban,
    bic: data.bic || null,
    bankCode: data.iban.startsWith('DE') ? data.iban.slice(4, 12) : null,
    bankName: data.bankName || null,
    currency: data.currency,
    isDefaultForBankTransfer: data.isDefaultForBankTransfer && data.isActive,
    isActive: data.isActive,
    updatedAt: new Date(),
  };
  try {
    return await withTransaction(ctx.db, async (tx) => {
      if (values.isDefaultForBankTransfer) {
        await tx
          .update(bankAccounts)
          .set({ isDefaultForBankTransfer: false })
          .where(
            id
              ? and(eq(bankAccounts.isDefaultForBankTransfer, true), ne(bankAccounts.id, id))
              : eq(bankAccounts.isDefaultForBankTransfer, true),
          );
      }
      if (id) {
        const [row] = await tx
          .update(bankAccounts)
          .set(values)
          .where(eq(bankAccounts.id, id))
          .returning({ id: bankAccounts.id });
        if (!row) throw new DomainError('NOT_FOUND', 'Bank account not found', 404);
        return row;
      }
      const [row] = await tx.insert(bankAccounts).values(values).returning({ id: bankAccounts.id });
      return row!;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'bank_accounts_iban_uq')) {
      throw new DomainError('IBAN_TAKEN', 'An account with this IBAN exists already', 409);
    }
    throw err;
  }
}

/** Accounts with imported transactions are kept (GoBD) – deactivate them instead. */
export async function deleteBankAccount(ctx: CoreContext, id: string): Promise<void> {
  const [usage] = await ctx.db
    .select({ n: count() })
    .from(bankTransactions)
    .where(eq(bankTransactions.bankAccountId, id));
  if ((usage?.n ?? 0) > 0) {
    throw new DomainError('HAS_TRANSACTIONS', 'The account has imported transactions', 409);
  }
  const connections = await ctx.db
    .select()
    .from(bankConnections)
    .where(eq(bankConnections.bankAccountId, id));
  for (const c of connections) await releaseProviderResources(ctx, c);
  await ctx.db.delete(bankAccounts).where(eq(bankAccounts.id, id));
}

export interface SaveConnectionInput {
  bankAccountId: string;
  name: string;
  isActive: boolean;
  /** null = manual sync only. */
  pollIntervalSeconds: number | null;
  config: unknown;
  /** New secret values; omitted / empty fields keep the stored ones. */
  secrets: Record<string, string | undefined>;
}

const REQUIRED_SECRET: Partial<Record<SupportedBankAdapter, string>> = {
  FINTS: 'pin',
  PSD2_FINAPI: 'clientSecret',
  IMAP: 'password',
};

export async function saveBankConnection(
  ctx: CoreContext,
  id: string | null,
  input: SaveConnectionInput,
  deps: FinApiDeps = {},
): Promise<{ id: string }> {
  const config: BankConnectionConfig = bankConnectionConfigSchema.parse(input.config);
  if (config.adapter === 'PSD2_GOCARDLESS') {
    throw new DomainError('NOT_SUPPORTED', 'This adapter is no longer supported', 422);
  }
  const adapter = config.adapter;
  // SSRF guard for admin-configured hosts (re-checked right before every connection).
  try {
    if (config.adapter === 'FINTS') await assertBankEndpointAllowed(config.serverUrl);
    if (config.adapter === 'IMAP') await assertMailHostAllowed(config.host);
  } catch (err) {
    if (err instanceof EndpointNotAllowedError) {
      throw new DomainError('HOST_NOT_ALLOWED', err.message, 422, {
        field: config.adapter === 'FINTS' ? 'serverUrl' : 'host',
      });
    }
    throw err;
  }
  const interval = input.pollIntervalSeconds;
  if (interval !== null && adapter !== 'FILE_IMPORT') {
    const min =
      adapter === 'PSD2_FINAPI' && !config.backgroundUpdate ? 3600 : MIN_POLL_INTERVAL[adapter];
    if (!Number.isInteger(interval) || interval < min) {
      throw new DomainError('POLL_INTERVAL', `Polling interval must be at least ${min} s`, 422, {
        min,
      });
    }
  }
  const pollIntervalSeconds = adapter === 'FILE_IMPORT' ? null : interval;
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new DomainError('NAME_REQUIRED', 'Name required', 422);

  let existing: BankConnectionRow | null = null;
  if (id) {
    const [row] = await ctx.db.select().from(bankConnections).where(eq(bankConnections.id, id));
    if (!row) throw new DomainError('NOT_FOUND', 'Connection not found', 404);
    if (row.adapter !== adapter)
      throw new DomainError('ADAPTER_CHANGE', 'Adapter cannot be changed', 422);
    existing = row;
  }
  const connectionId = id ?? randomUUID();
  const previous = existing
    ? (decryptConnectionSecrets(ctx, existing, adapter) as Record<string, unknown> | null)
    : null;
  const provided = Object.fromEntries(
    Object.entries(input.secrets).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
  );
  let secretsValue: BankConnectionSecrets | null = null;
  if (adapter !== 'FILE_IMPORT') {
    const merged = { ...(previous ?? {}), ...provided, adapter };
    const required = REQUIRED_SECRET[adapter]!;
    if (!merged[required as keyof typeof merged]) {
      throw new DomainError('SECRET_REQUIRED', `${required} is required`, 422, { field: required });
    }
    secretsValue = bankConnectionSecretsSchema.parse(merged);
  }

  // Reset adapter state when the identity of the remote login changes.
  let state: Record<string, unknown> | undefined;
  if (existing) {
    const before = existing.config;
    if (adapter === 'PSD2_FINAPI' && before.adapter === 'PSD2_FINAPI') {
      if (before.environment !== config.environment || before.clientId !== config.clientId) {
        await releaseProviderResources(ctx, existing, deps).catch(() => undefined);
        state = {};
        if (secretsValue?.adapter === 'PSD2_FINAPI') {
          secretsValue = { adapter: 'PSD2_FINAPI', clientSecret: secretsValue.clientSecret };
        }
      }
    }
    if (
      adapter === 'FINTS' &&
      before.adapter === 'FINTS' &&
      finTsIdentity(before) !== finTsIdentity(config)
    ) {
      state = {};
    }
  }

  const becameDue =
    pollIntervalSeconds !== null &&
    input.isActive &&
    (!existing ||
      !existing.isActive ||
      existing.pollIntervalSeconds !== pollIntervalSeconds ||
      existing.nextSyncAt === null);
  const values = {
    bankAccountId: input.bankAccountId,
    adapter,
    name,
    isActive: input.isActive,
    pollIntervalSeconds,
    config,
    credentialsEncrypted: secretsValue
      ? encryptConnectionSecrets(ctx, connectionId, secretsValue)
      : null,
    ...(state !== undefined ? { state } : {}),
    ...(becameDue ? { nextSyncAt: new Date() } : {}),
    ...(pollIntervalSeconds === null || !input.isActive ? { nextSyncAt: null } : {}),
    updatedAt: new Date(),
  };
  if (existing) {
    await ctx.db.update(bankConnections).set(values).where(eq(bankConnections.id, connectionId));
  } else {
    await ctx.db
      .insert(bankConnections)
      .values({ id: connectionId, ...values, state: state ?? {} });
  }
  return { id: connectionId };
}

/** Removes provider-side resources (finAPI user + consent) of a connection. */
async function releaseProviderResources(
  ctx: CoreContext,
  connection: BankConnectionRow,
  deps: FinApiDeps = {},
): Promise<void> {
  if (connection.adapter === 'PSD2_FINAPI') await disconnectFinApi(ctx, connection, deps);
}

export async function deleteBankConnection(
  ctx: CoreContext,
  id: string,
  deps: FinApiDeps = {},
): Promise<void> {
  const [row] = await ctx.db.select().from(bankConnections).where(eq(bankConnections.id, id));
  if (!row) throw new DomainError('NOT_FOUND', 'Connection not found', 404);
  if (row.lastSyncStatus === 'RUNNING' || row.lastSyncStatus === 'TAN_REQUIRED') {
    throw new DomainError('BUSY', 'A sync is running', 409);
  }
  await releaseProviderResources(ctx, row, deps);
  // Transactions, imports and sync runs keep their history (FKs set null / cascade on runs).
  await ctx.db.delete(bankConnections).where(eq(bankConnections.id, id));
}
