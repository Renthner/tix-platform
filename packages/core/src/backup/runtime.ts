import { normalizeLocale, type SettingValue } from '@tix/shared';
import type { SecretBoxKey } from '@tix/shared/server';
import type { CoreContext } from '../context';
import { smtpSender } from '../email/transport';
import { getSecretSetting, getSetting } from '../settings';
import type { PgBinaries } from './pg';
import { assertSafeEndpoint, EndpointNotAllowedError } from './endpoint-guard';
import { S3Bucket, type BackupBuckets } from './s3';

export interface BackupLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Everything the worker-side backup operations need (built once in the worker). */
export interface BackupRuntime {
  ctx: CoreContext;
  buckets: BackupBuckets;
  /** Raw key ring (`APP_ENCRYPTION_KEYS`); the first key encrypts new archives. */
  keyRing: readonly SecretBoxKey[];
  databaseUrl: string;
  /** Directory with the SQL migrations and `meta/_journal.json`. */
  migrationsDir: string;
  appVersion: string;
  pg: PgBinaries;
  /** Wait after the maintenance flag was set (default 10 s); tests use 0. */
  drainGraceMs?: number;
  logger: BackupLogger;
}

export interface ExternalTarget {
  bucket: S3Bucket;
  /** Key prefix inside the external bucket ('' or ending with '/'). */
  prefix: string;
}

/** The configured external S3 target, or null when disabled / incomplete. */
export async function loadExternalTarget(
  ctx: Pick<CoreContext, 'db' | 'secrets'>,
): Promise<ExternalTarget | null> {
  const settings = await getSetting(ctx, 'backup');
  if (!settings.externalEnabled) return null;
  return buildExternalTarget(ctx, settings);
}

/** Builds the target from the settings even when it is not enabled (connection test). */
export async function buildExternalTarget(
  ctx: Pick<CoreContext, 'db' | 'secrets'>,
  settings: SettingValue<'backup'>,
  /** Credentials typed in the form (not saved yet); default: the stored ones. */
  credentialsOverride?: { accessKeyId: string; secretAccessKey: string } | null,
): Promise<ExternalTarget | null> {
  const credentials =
    credentialsOverride ?? (await getSecretSetting(ctx, 'backup.external.credentials'));
  if (!settings.externalEndpoint || !settings.externalBucket || !credentials) return null;
  // SSRF guard: https only and no non-public targets unless explicitly allowed in the settings.
  await assertSafeEndpoint(settings.externalEndpoint, {
    allowInsecure: settings.allowInsecureEndpoint,
    allowPrivate: settings.allowPrivateNetwork,
  });
  const prefix = settings.externalPrefix.replace(/^\/+/, '').replace(/\/*$/, '');
  return {
    bucket: new S3Bucket({
      endpoint: settings.externalEndpoint,
      region: settings.externalRegion,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      forcePathStyle: settings.externalForcePathStyle,
      bucket: settings.externalBucket,
      guard: { allowPrivateNetwork: settings.allowPrivateNetwork },
    }),
    prefix: prefix ? `${prefix}/` : '',
  };
}

/** "Test connection" (saved settings or the unsaved form values): write, read back, delete a probe. */
export async function testExternalTarget(
  ctx: Pick<CoreContext, 'db' | 'secrets'>,
  input?: {
    settings: SettingValue<'backup'>;
    credentials?: { accessKeyId: string; secretAccessKey: string } | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = input?.settings ?? (await getSetting(ctx, 'backup'));
  let target: ExternalTarget | null = null;
  try {
    target = await buildExternalTarget(ctx, settings, input?.credentials);
    if (!target) return { ok: false, error: 'INCOMPLETE' };
    await target.bucket.checkAccess(target.prefix + '.tix-connection-probe');
    return { ok: true };
  } catch (err) {
    // Only a coarse error code reaches the UI (no hostnames, addresses or provider messages).
    if (err instanceof EndpointNotAllowedError) return { ok: false, error: 'ENDPOINT_NOT_ALLOWED' };
    const name = (err as { name?: string })?.name ?? '';
    return { ok: false, error: /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : 'CONNECTION_FAILED' };
  } finally {
    target?.bucket.destroy();
  }
}

/** Short, secret-free description of an error for the UI / alert mail. */
export function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; Code?: string };
  const text = e?.message && e.message !== 'UnknownError' ? e.message : (e?.Code ?? e?.name ?? '');
  return (text || String(err)).replace(/\s+/g, ' ').slice(0, 300);
}

const ALERT_TEXT = {
  en: {
    subject: (shop: string) => `${shop}: scheduled backup failed`,
    body: (shop: string, message: string) =>
      `The scheduled backup of ${shop} failed.\n\nReason: ${message}\n\nOpen the admin area under "Backups" to see the details and to start a manual backup.`,
  },
  de: {
    subject: (shop: string) => `${shop}: Geplante Sicherung fehlgeschlagen`,
    body: (shop: string, message: string) =>
      `Die geplante Sicherung von ${shop} ist fehlgeschlagen.\n\nGrund: ${message}\n\nIm Admin-Bereich unter "Sicherungen" findest du die Details und kannst eine manuelle Sicherung starten.`,
  },
} as const;

/**
 * Plain system mail through the configured SMTP server (no template / outbox row: an alert
 * must not depend on database state and needs no schema change).
 */
export async function sendBackupAlert(
  ctx: CoreContext,
  to: string,
  message: string,
): Promise<boolean> {
  const general = await getSetting(ctx, 'general');
  const text = ALERT_TEXT[normalizeLocale(general.defaultLocale)];
  const sender = await smtpSender(ctx);
  await sender.transporter.sendMail({
    from: sender.from,
    to,
    subject: text.subject(general.shopName),
    text: text.body(general.shopName, message),
  });
  return true;
}
