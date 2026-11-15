import { auditLogs, adminUsers } from '@tix/db';
import { keyLabel, loadExtraKeys, removeExtraKeys } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { reEncryptSecrets, type ReEncryptResult } from '../secrets/reencrypt';
import { describeError, type BackupRuntime } from './runtime';
import {
  clearReEncryptPending,
  clearSecretsUnreadable,
  setSecretsUnreadable,
  type Progress,
} from './state';

/**
 * "Re-encrypt all secrets with this system's key": decrypts every registered secret that needs an
 * additional / foreign key and encrypts it with the primary key (`reEncryptSecrets`); only when the
 * verification pass found nothing left that needs another key are the additional keys removed
 * from the extra keys file. Backups made before still need the source key.
 */
export interface ReEncryptOutcome extends ReEncryptResult {
  /** Entries removed from the additional keys file. */
  removedKeys: number;
  /** Labels `id (fingerprint)` (never material) of the additional keys that were removed. */
  removedKeyIds: string[];
}

/** Compact, language neutral summary for the status panel (the UI translates it). */
export function summariseReEncrypt(outcome: ReEncryptOutcome): string {
  return JSON.stringify({
    complete: outcome.complete,
    removedKeys: outcome.removedKeys,
    undecryptable: outcome.tables.reduce((n, t) => n + t.undecryptable, 0),
    remaining: outcome.remainingForeign,
    tables: outcome.tables.map((t) => [t.id, t.reEncrypted, t.skipped, t.undecryptable]),
  });
}

export async function runReEncryptSecrets(
  rt: BackupRuntime,
  params: { userId: string | null; trigger: 'RESTORE' | 'MANUAL'; progress: Progress },
): Promise<ReEncryptOutcome> {
  const ring = rt.keyRing;
  const primary = ring[0];
  if (!primary) throw new Error('No encryption key is configured');
  await params.progress.step('REENCRYPT');
  const result = await reEncryptSecrets(rt.ctx, {
    primary,
    allKeys: ring,
    onTable: (id) => params.progress.step('REENCRYPT', id),
  });

  let removedKeyIds: string[] = [];
  if (result.complete) {
    // The verification pass proved that the primary key alone opens everything that is registered.
    await params.progress.step('REENCRYPT_CLEANUP');
    // Remove exactly the entries that were read (and are logged), not whatever the file holds later.
    const extras = loadExtraKeys();
    removeExtraKeys(extras);
    removedKeyIds = extras.map(keyLabel);
  }
  const outcome: ReEncryptOutcome = {
    ...result,
    removedKeys: removedKeyIds.length,
    removedKeyIds,
  };
  // The pass ran: the "queued" notice is obsolete and the unreadable-secrets notice follows the result.
  await clearReEncryptPending(rt.ctx).catch(() => undefined);
  if (result.complete) {
    await clearSecretsUnreadable(rt.ctx).catch(() => undefined);
  } else if (result.remainingForeign > 0) {
    await setSecretsUnreadable(rt.ctx, {
      count: result.remainingForeign,
      at: new Date().toISOString(),
      source: 'REENCRYPT',
    }).catch(() => undefined);
  }
  await recordReEncryptAudit(rt, params.userId, params.trigger, outcome).catch((err) =>
    rt.logger.warn({ err: describeError(err) }, 're-encryption audit entry could not be written'),
  );
  return outcome;
}

/** Counts and ids only; never values or key material. */
async function recordReEncryptAudit(
  rt: BackupRuntime,
  userId: string | null,
  trigger: 'RESTORE' | 'MANUAL',
  outcome: ReEncryptOutcome,
): Promise<void> {
  let actor: string | null = null;
  if (userId) {
    const [row] = await rt.ctx.db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.id, userId));
    actor = row?.id ?? null;
  }
  await rt.ctx.db.insert(auditLogs).values({
    actorType: 'ADMIN' as const,
    actorUserId: actor,
    action: 'secrets.reencrypt',
    entityType: 'secrets',
    entityId: null,
    changes: {
      trigger,
      complete: outcome.complete,
      removedKeyIds: outcome.removedKeyIds,
      remainingForeign: outcome.remainingForeign,
      tables: outcome.tables,
      undecryptable: outcome.undecryptable,
    },
    metadata: actor || !userId ? null : { requestedByUserId: userId },
  });
}
