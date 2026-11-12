'use server';

import {
  DomainError,
  checkAdminPassword,
  clearSecretSetting,
  assertBackupIdle,
  countRestoreLoss,
  deleteBackup,
  findBackup,
  getSetting,
  hasSecretSetting,
  requestBackup,
  requestRestore,
  requestVerify,
  saveSecretSetting,
  saveSetting,
  testExternalTarget,
  verifyAdminSecondFactor,
} from '@tix/core';
import { parseSetting } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import type { BackupActionState, RestorePreview } from '@/lib/backup-state';
import { requireAdmin } from '@/server/auth';
import { getBackupBuckets } from '@/server/backups';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit, uuidParam } from '@/server/http';
import { logger } from '@/server/logger';
import { audit } from './audit';
import { fieldError, flag, success, text, zodFieldErrors } from './form';

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
    saved = await saveSetting(core, 'backup', input, session.userId);
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
  const [loss, account] = await Promise.all([
    countRestoreLoss(core, entry.manifest.createdAt),
    core.db.query.adminUsers.findFirst({
      columns: { totpSecretEncrypted: true },
      where: (u, { eq }) => eq(u.id, session.userId),
    }),
  ]);
  const settings = await getSetting(core, 'backup');
  const twoFactor = Boolean(account?.totpSecretEncrypted);
  return {
    backupCreatedAt: entry.manifest.createdAt,
    loss,
    twoFactor,
    twoFactorSetupRequired: settings.restoreRequiresTwoFactor && !twoFactor,
  };
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
    const password = fd.get('password');
    // Unknown / inactive / locked accounts and wrong passwords all answer "invalid".
    const check = await checkAdminPassword(
      core,
      session.email,
      typeof password === 'string' ? password : '',
      await clientIp(),
    );
    if (check.status !== 'ok' || check.userId !== session.userId) return fail('password');
    if ((await getSetting(core, 'backup')).restoreRequiresTwoFactor && !check.twoFactor) {
      return fail('twoFactorSetupRequired');
    }
    if (check.twoFactor) {
      const code = text(fd, 'code');
      if (!code) return fail('twoFactorRequired');
      try {
        await verifyAdminSecondFactor(core, session.userId, code);
      } catch (err) {
        if (err instanceof DomainError) {
          return fail(err.code === 'ACCOUNT_LOCKED' ? 'locked' : 'twoFactorInvalid');
        }
        throw err;
      }
    }

    const entry = await findBackup(getBackupBuckets().backups, backupId);
    if (!entry) return fail('notFound');
    // Migration level, key and checksum are validated by the worker before anything is touched.

    await requestRestore(core, backupId, session.userId);
    await audit(core.db, session, 'backup.restore.requested', 'backup', backupId, {
      backupCreatedAt: entry.manifest.createdAt,
    });
    return queued();
  });
}
