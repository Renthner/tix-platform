'use server';

import {
  DomainError,
  type PublicKeyCredentialRequestOptionsJSON,
  beginPasskeyReauth,
  bindFromSecret,
  countAdminPasskeys,
  passkeysAvailable,
  clearSecretSetting,
  assertBackupIdle,
  clearReEncryptPending,
  clearSecretsUnreadable,
  setSecretsUnreadable,
  verifySecretsReadable,
  secretKeysMissingFrom,
  archiveKey,
  checkBackupKey,
  countRestoreLoss,
  deleteBackup,
  findBackup,
  getSetting,
  hasSecretSetting,
  nextScheduleConfiguredAt,
  requestBackup,
  requestProbe,
  requestReEncrypt,
  requestRestore,
  requestVerify,
  saveSecretSetting,
  saveSetting,
  SourceKeysError,
  foreignBackupKeysAllowed,
  stageSourceKeys,
  parseSourceKeys,
  testExternalTarget,
} from '@tix/core';
import { parseSetting } from '@tix/shared';
import {
  loadExtraKeys,
  loadKeyRing,
  mergeKeyRings,
  parseKeyRing,
  type SecretBoxKey,
} from '@tix/shared/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import type {
  BackupActionState,
  RestorePreview,
  SourceKeyCheck,
  StageKeysResult,
} from '@/lib/backup-state';
import { requireAdmin } from '@/server/auth';
import { getBackupBuckets } from '@/server/backups';
import { getCore } from '@/server/core';
import { getEnv } from '@/server/env';
import { clientIp, enforceRateLimit, uuidParam } from '@/server/http';
import { logger } from '@/server/logger';
import { audit } from './audit';
import { fieldError, flag, success, text, zodFieldErrors } from './form';
import { reauthenticate as reauthWith } from './reauth';

const fail = (
  code: Extract<BackupActionState, { status: 'error' }>['code'],
  detail?: string,
): BackupActionState => ({ status: 'error', code, ...(detail ? { detail } : {}), at: Date.now() });
const queued = (): BackupActionState => ({ status: 'success', code: 'queued', at: Date.now() });

// Lazy: the logger validates the environment, which must not happen while Next.js collects page data.
const log = () => logger.child({ component: 'backups' });
const backupLogger = {
  info: (obj: object, msg?: string) => log().info(obj, msg),
  warn: (obj: object, msg?: string) => log().warn(obj, msg),
  error: (obj: object, msg?: string) => log().error(obj, msg),
};

async function guarded(fn: () => Promise<BackupActionState>): Promise<BackupActionState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === 'BACKUP_BUSY') return fail('busy');
      if (err.code === 'RATE_LIMITED') return fail('rateLimited');
      if (err.code === 'BACKUP_PROTECTED') return fail('protected');
    }
    throw err;
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────────────

type Errors = Partial<Record<string, FieldErrorCode>>;

function intField(fd: FormData, name: string, errors: Errors): number | undefined {
  const raw = text(fd, name);
  if (raw === undefined) {
    errors[name] = 'required';
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    errors[name] = 'invalid';
    return undefined;
  }
  return n;
}

function readSettings(fd: FormData, errors: Errors): Record<string, unknown> {
  return {
    scheduleEnabled: flag(fd, 'scheduleEnabled'),
    frequency: text(fd, 'frequency'),
    weekday: intField(fd, 'weekday', errors),
    time: text(fd, 'time'),
    probeEnabled: flag(fd, 'probeEnabled'),
    probeFrequency: text(fd, 'probeFrequency'),
    probeWeekday: intField(fd, 'probeWeekday', errors),
    probeTime: text(fd, 'probeTime'),
    keepScheduled: intField(fd, 'keepScheduled', errors),
    manualMaxAgeDays: intField(fd, 'manualMaxAgeDays', errors),
    maxUploadMb: intField(fd, 'maxUploadMb', errors),
    restoreRequiresTwoFactor: flag(fd, 'restoreRequiresTwoFactor'),
    allowInsecureEndpoint: flag(fd, 'allowInsecureEndpoint'),
    allowPrivateNetwork: flag(fd, 'allowPrivateNetwork'),
    externalEnabled: flag(fd, 'externalEnabled'),
    externalEndpoint: text(fd, 'externalEndpoint'),
    externalBucket: text(fd, 'externalBucket'),
    externalRegion: text(fd, 'externalRegion'),
    externalPrefix: text(fd, 'externalPrefix') ?? '',
    externalForcePathStyle: flag(fd, 'externalForcePathStyle'),
    alertEmail: text(fd, 'alertEmail'),
  };
}

/** Credentials typed into the form (both fields or none). */
function readCredentials(
  fd: FormData,
  errors: Errors,
): { accessKeyId: string; secretAccessKey: string } | null {
  const accessKeyId = text(fd, 'accessKeyId');
  const secret = fd.get('secretAccessKey');
  const secretAccessKey = typeof secret === 'string' && secret !== '' ? secret : undefined;
  if (!accessKeyId && !secretAccessKey) return null;
  if (!accessKeyId) errors.accessKeyId = 'required';
  if (!secretAccessKey) errors.secretAccessKey = 'required';
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}

function mapErrors(err: z.ZodError): Errors {
  const fields = zodFieldErrors(err);
  if (fields.alertEmail) fields.alertEmail = 'email';
  if (fields.externalEndpoint) fields.externalEndpoint = 'url';
  return fields;
}

export async function saveBackupSettingsAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const core = getCore();
  const errors: Errors = {};
  const input = readSettings(fd, errors);
  const credentials = readCredentials(fd, errors);
  const clear = flag(fd, 'clearCredentials');
  const stored = await hasSecretSetting(core, 'backup.external.credentials');
  // Pointing the stored keys at another endpoint / bucket needs the keys typed in again.
  const current = await getSetting(core, 'backup');
  if (
    stored &&
    !clear &&
    !credentials &&
    (input.externalEndpoint !== current.externalEndpoint ||
      input.externalBucket !== current.externalBucket)
  ) {
    errors.secretAccessKey = 'secretRequired';
  }
  if (input.externalEnabled) {
    if (!input.externalEndpoint) errors.externalEndpoint = 'required';
    if (!input.externalBucket) errors.externalBucket = 'required';
    if (!credentials && (!stored || clear)) errors.secretAccessKey = 'secretRequired';
  }
  if (Object.keys(errors).length > 0) return fieldError(errors);

  let saved: unknown;
  try {
    // The reference time of the missed / overdue alerts moves only when the schedule changes.
    const scheduleConfiguredAt = nextScheduleConfiguredAt(current, parseSetting('backup', input));
    saved = await saveSetting(
      core,
      'backup',
      { ...input, ...(scheduleConfiguredAt ? { scheduleConfiguredAt } : {}) },
      session.userId,
    );
  } catch (err) {
    if (err instanceof z.ZodError) return fieldError(mapErrors(err));
    throw err;
  }
  let change: 'replaced' | 'removed' | null = null;
  if (credentials) {
    await saveSecretSetting(core, 'backup.external.credentials', credentials, session.userId);
    change = 'replaced';
  } else if (clear) {
    await clearSecretSetting(core, 'backup.external.credentials');
    change = 'removed';
  }
  await audit(core.db, session, 'settings.update', 'system_setting', 'backup', {
    value: saved,
    ...(change ? { secret: { key: 'backup.external.credentials', change } } : {}),
  });
  revalidatePath('/', 'layout');
  return success('saved');
}

/** "Test connection" with the values currently typed into the form (nothing is saved). */
export async function testBackupTargetAction(
  _prev: BackupActionState,
  fd: FormData,
): Promise<BackupActionState> {
  await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const errors: Errors = {};
  const input = readSettings(fd, errors);
  const credentials = readCredentials(fd, errors);
  let settings: ReturnType<typeof parseSetting<'backup'>>;
  try {
    settings = parseSetting('backup', input);
  } catch (err) {
    if (err instanceof z.ZodError) return fail('connectionIncomplete');
    throw err;
  }
  const result = await testExternalTarget(getCore(), { settings, credentials });
  if (result.ok) return { status: 'success', code: 'connectionOk', at: Date.now() };
  if (result.error === 'INCOMPLETE') return fail('connectionIncomplete');
  if (result.error === 'ENDPOINT_NOT_ALLOWED') return fail('endpointNotAllowed');
  return fail('connectionFailed', result.error);
}

// ─── Operations ───────────────────────────────────────────────────────────────────────

export async function backupNowAction(): Promise<BackupActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  return guarded(async () => {
    const core = getCore();
    await requestBackup(core, session.userId);
    await audit(core.db, session, 'backup.create', 'backup', null);
    revalidatePath('/admin/backups');
    return queued();
  });
}

/** "Run probe now": restores the newest backup into a throwaway database (worker). */
export async function probeNowAction(): Promise<BackupActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  return guarded(async () => {
    const core = getCore();
    await requestProbe(core, session.userId);
    await audit(core.db, session, 'backup.probe.requested', 'backup', null);
    revalidatePath('/admin/backups');
    return queued();
  });
}

export async function verifyBackupAction(id: string): Promise<BackupActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  return guarded(async () => {
    const backupId = uuidParam.parse(id);
    const core = getCore();
    if (!(await findBackup(getBackupBuckets().backups, backupId))) return fail('notFound');
    await requestVerify(core, backupId);
    await audit(core.db, session, 'backup.verify', 'backup', backupId);
    return queued();
  });
}

export async function deleteBackupAction(
  id: string,
  deleteExternal: boolean,
): Promise<BackupActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  return guarded(async () => {
    const backupId = uuidParam.parse(id);
    const core = getCore();
    await assertBackupIdle(core);
    const deleted = await deleteBackup(
      { ctx: core, buckets: getBackupBuckets(), logger: backupLogger },
      backupId,
      { deleteExternal },
    );
    if (!deleted) return fail('notFound');
    await audit(core.db, session, 'backup.delete', 'backup', backupId, { deleteExternal });
    revalidatePath('/admin/backups');
    return { status: 'success', code: 'deleted', at: Date.now() };
  });
}

// ─── Restore ──────────────────────────────────────────────────────────────────────────

/** Data for the confirmation dialog: what the restore would discard. */
export async function previewRestoreAction(id: string): Promise<RestorePreview | null> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const core = getCore();
  const entry = await findBackup(getBackupBuckets().backups, uuidParam.parse(id));
  if (!entry) return null;
  const [loss, account, passkeyCount] = await Promise.all([
    countRestoreLoss(core, entry.manifest.createdAt),
    core.db.query.adminUsers.findFirst({
      columns: { totpSecretEncrypted: true },
      where: (u, { eq }) => eq(u.id, session.userId),
    }),
    countAdminPasskeys(core, session.userId),
  ]);
  const settings = await getSetting(core, 'backup');
  // An authenticator app or a registered passkey is a second factor (like at sign-in).
  const twoFactor = Boolean(account?.totpSecretEncrypted) || passkeyCount > 0;
  return {
    backupCreatedAt: entry.manifest.createdAt,
    loss,
    twoFactor,
    passkeys: passkeyCount > 0 && passkeysAvailable(core),
    twoFactorSetupRequired: settings.restoreRequiresTwoFactor && !twoFactor,
    foreignKeysAllowed: foreignBackupKeysAllowed(),
    // Cheap header + first block check with this system's own keys: tells the dialog up front
    // that the backup comes from another system and needs its key.
    needsSourceKey: await needsSourceKey(entry.directory),
    additionalKeys: additionalKeyCount(),
    // Secrets inside the backup that depend on keys this system does not have.
    secretKeysMissing: secretKeysMissingFrom(entry.manifest, currentKeyRing()),
  };
}

async function needsSourceKey(directory: string): Promise<boolean> {
  try {
    return (
      (await checkBackupKey(
        getBackupBuckets().backups,
        archiveKey(directory),
        archiveKeyRing(),
      )) !== 'MATCH'
    );
  } catch {
    return false;
  }
}

/** Number of additional (foreign) decrypt keys on this system's data volume. */
function additionalKeyCount(): number {
  try {
    return loadExtraKeys().length;
  } catch {
    return 0;
  }
}

/** Binds a restore passkey challenge to this restore confirmation (action + backup). */
const restoreBind = (backupId: string) => bindFromSecret(`restore:${backupId}`);

export type RestorePasskeyOptions =
  | { ok: true; options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }
  | { ok: false; error: 'failed' | 'rateLimited' | 'locked' };

/** Step 1 of confirming a restore with a passkey: single-use challenge for this backup. */
export async function restorePasskeyOptionsAction(id: string): Promise<RestorePasskeyOptions> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const core = getCore();
  try {
    const backupId = uuidParam.parse(id);
    await enforceRateLimit('backup-restore-options', session.userId, 20, 15 * 60_000);
    return { ok: true, ...(await beginPasskeyReauth(core, session.userId, restoreBind(backupId))) };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, error: err.code === 'RATE_LIMITED' ? 'rateLimited' : 'failed' };
    }
    if (err instanceof z.ZodError) return { ok: false, error: 'failed' };
    throw err;
  }
}

/** Fresh password + second factor / passkey for a backup action (shared helper). */
async function reauthenticate(
  core: ReturnType<typeof getCore>,
  session: Awaited<ReturnType<typeof requireAdmin>>,
  fd: FormData,
  bind: string,
): Promise<BackupActionState | null> {
  const denied = await reauthWith(core, session, fd, {
    purpose: 'restore',
    bind,
    requireTwoFactor: (await getSetting(core, 'backup')).restoreRequiresTwoFactor,
  });
  return denied ? fail(denied) : null;
}

/**
 * Restore: fresh password, authenticator / recovery code when the user has 2FA, explicit
 * acknowledgement. Everything else (validation, safety backup, maintenance mode) runs in the worker.
 */
export async function restoreBackupAction(
  id: string,
  _prev: BackupActionState,
  fd: FormData,
): Promise<BackupActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  return guarded(async () => {
    const backupId = uuidParam.parse(id);
    const core = getCore();
    await enforceRateLimit('backup-restore', session.userId, 5, 15 * 60_000);
    await enforceRateLimit('backup-restore-ip', await clientIp(), 20, 15 * 60_000);

    if (!flag(fd, 'acknowledge')) return fail('acknowledge');
    const denied = await reauthenticate(core, session, fd, restoreBind(backupId));
    if (denied) return denied;

    const entry = await findBackup(getBackupBuckets().backups, backupId);
    if (!entry) return fail('notFound');
    // Migration level, key and checksum are validated by the worker before anything is touched.

    // Encryption key(s) of the source system (backup of another installation): parked encrypted
    // with this system's key; only an opaque token goes into the job. Never logged, never audited.
    const sourceKeysText = fd.get('sourceKeys');
    let keyToken: string | undefined;
    if (typeof sourceKeysText === 'string' && sourceKeysText.trim() !== '') {
      try {
        keyToken = await stageSourceKeys(core, sourceKeysText);
      } catch (err) {
        if (err instanceof SourceKeysError) {
          return fail(err.code === 'DISABLED' ? 'sourceKeysDisabled' : 'sourceKeysInvalid');
        }
        throw err;
      }
    }

    // Checkbox, default on in the dialog: only meaningful together with source keys.
    const reencrypt = Boolean(keyToken) && flag(fd, 'reencrypt');
    await requestRestore(core, backupId, session.userId, keyToken, reencrypt);
    await audit(core.db, session, 'backup.restore.requested', 'backup', backupId, {
      backupCreatedAt: entry.manifest.createdAt,
      // Whether an extra key was supplied, never the key itself.
      sourceKeysSupplied: Boolean(keyToken),
      reencrypt,
    });
    return queued();
  });
}

// ─── Keys of another system ───────────────────────────────────────────────────────────

/** The ring of THIS system (configured keys + additional keys already stored): for stored secrets. */
const currentKeyRing = () => loadKeyRing(getEnv().APP_ENCRYPTION_KEYS);

/**
 * Keys that may open ARCHIVES: the configured keys, plus additional keys of other systems only
 * while the operator allows them (`TIX_ALLOW_FOREIGN_BACKUP_KEYS`), like the worker does.
 */
const archiveKeyRing = () =>
  foreignBackupKeysAllowed() ? currentKeyRing() : parseKeyRing(getEnv().APP_ENCRYPTION_KEYS);

/**
 * "Check key": does the entered source key decrypt this backup? Reads only the header and the
 * first encrypted block; starts nothing, stores nothing, and the key is not echoed back.
 */
export async function checkSourceKeysAction(id: string, keysText: string): Promise<SourceKeyCheck> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  try {
    await enforceRateLimit('backup-key-check', session.userId, 20, 15 * 60_000);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'RATE_LIMITED') return { result: 'rateLimited' };
    throw err;
  }
  if (!foreignBackupKeysAllowed()) return { result: 'disabled' };
  if (typeof keysText !== 'string' || keysText.trim() === '') return { result: 'empty' };
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) return { result: 'notFound' };
  let current: SecretBoxKey[];
  let pasted: SecretBoxKey[];
  try {
    current = archiveKeyRing();
    pasted = parseSourceKeys(keysText);
  } catch (err) {
    if (err instanceof SourceKeysError) return { result: 'invalid' };
    throw err;
  }
  const buckets = getBackupBuckets();
  const entry = await findBackup(buckets.backups, parsed.data);
  if (!entry) return { result: 'notFound' };
  const archive = archiveKey(entry.directory);
  // Already readable with this system's own keys: the pasted keys are not needed for the archive.
  // Secrets of the backup whose key is neither among this system's keys nor among the pasted ones.
  const stillMissing = secretKeysMissingFrom(
    entry.manifest,
    mergeKeyRings(currentKeyRing(), pasted),
  ).length;
  if ((await checkBackupKey(buckets.backups, archive, current)) === 'MATCH') {
    return { result: 'readable', stillMissing };
  }
  // Only the pasted keys decide the outcome (the own keys were tried above).
  const outcome = await checkBackupKey(buckets.backups, archive, pasted);
  return {
    result:
      outcome === 'MATCH'
        ? 'match'
        : outcome === 'KEY_UNKNOWN'
          ? 'unknown'
          : outcome === 'NOT_A_BACKUP'
            ? 'notBackup'
            : 'mismatch',
    stillMissing,
  };
}

/** Parks the typed source keys for the next upload (single-use token, valid for one hour). */
export async function stageUploadKeysAction(keysText: string): Promise<StageKeysResult> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  if (!foreignBackupKeysAllowed()) return { ok: false, error: 'disabled' };
  try {
    await enforceRateLimit('backup-key-stage', session.userId, 20, 15 * 60_000);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'RATE_LIMITED') {
      return { ok: false, error: 'rateLimited' };
    }
    throw err;
  }
  try {
    return {
      ok: true,
      token: await stageSourceKeys(getCore(), String(keysText)),
    };
  } catch (err) {
    if (err instanceof SourceKeysError) {
      return { ok: false, error: err.code === 'DISABLED' ? 'disabled' : 'invalid' };
    }
    throw err;
  }
}

// ─── Re-encryption of secrets ─────────────────────────────────────────────────────────

/** Binds a passkey challenge to "re-encrypt secrets" (separate from any restore). */
const reEncryptBind = () => bindFromSecret('reencrypt-secrets');

/** Step 1 of confirming "re-encrypt now" with a passkey. */
export async function reEncryptPasskeyOptionsAction(): Promise<RestorePasskeyOptions> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const core = getCore();
  try {
    await enforceRateLimit('backup-reencrypt-options', session.userId, 20, 15 * 60_000);
    return { ok: true, ...(await beginPasskeyReauth(core, session.userId, reEncryptBind())) };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, error: err.code === 'RATE_LIMITED' ? 'rateLimited' : 'failed' };
    }
    throw err;
  }
}

/**
 * "Re-encrypt now": moves every stored secret that still depends on an additional key to this
 * system's key (worker job), then drops the unused additional keys. Fresh password + second factor
 * like a restore; audited (the worker adds counts per table).
 */
export async function reEncryptNowAction(
  _prev: BackupActionState,
  fd: FormData,
): Promise<BackupActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  return guarded(async () => {
    const core = getCore();
    await enforceRateLimit('backup-reencrypt', session.userId, 5, 15 * 60_000);
    await enforceRateLimit('backup-reencrypt-ip', await clientIp(), 20, 15 * 60_000);
    // Removing the additional keys is irreversible for older backups: explicit acknowledgement.
    if (additionalKeyCount() > 0 && !flag(fd, 'acknowledge')) return fail('acknowledge');
    const denied = await reauthenticate(core, session, fd, reEncryptBind());
    if (denied) return denied;
    await requestReEncrypt(core, session.userId, 'MANUAL');
    await audit(core.db, session, 'secrets.reencrypt.requested', 'secrets', null, {
      additionalKeys: additionalKeyCount(),
      acknowledgedKeyRemoval: additionalKeyCount() > 0,
    });
    revalidatePath('/admin/backups');
    return queued();
  });
}

/**
 * "Check again" for the "stored secrets cannot be read" notice: re-runs the verification pass with
 * this system's keys (e.g. after the affected credentials were entered anew) and clears the notice
 * when nothing is unreadable any more, otherwise updates the count.
 */
export async function recheckSecretsAction(): Promise<BackupActionState> {
  await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const core = getCore();
  const readable = await verifySecretsReadable(core, currentKeyRing());
  if (readable.unreadable === 0) await clearSecretsUnreadable(core);
  else {
    await setSecretsUnreadable(core, {
      count: readable.unreadable,
      at: new Date().toISOString(),
      source: 'RESTORE',
    });
  }
  revalidatePath('/admin/backups');
  return { status: 'idle' };
}

/** Hides the "re-encryption pending" notice (it stays gone; "Re-encrypt now" still works). */
export async function dismissReEncryptPendingAction(): Promise<BackupActionState> {
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const core = getCore();
  await clearReEncryptPending(core);
  await audit(core.db, session, 'secrets.reencrypt.pending.dismissed', 'secrets', null);
  revalidatePath('/admin/backups');
  return { status: 'idle' };
}
