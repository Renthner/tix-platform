import { systemSettings, type Executor } from '@tix/db';
import {
  SETTINGS,
  defaultSetting,
  parseSetting,
  type SettingKey,
  type SettingValue,
} from '@tix/shared';
import { eq } from 'drizzle-orm';
import type { CoreContext } from './context';

/**
 * Read access to non-secret system settings with a short in-process cache.
 * Writes publish a config-invalidation message so other processes drop their cache.
 */

const TTL_MS = 10_000;
/**
 * Process-wide on `globalThis`: Next.js bundles this module into several layers (RSC, SSR, route
 * handlers), and the pub/sub invalidation must reach every copy's data.
 */
const g = globalThis as typeof globalThis & {
  __tixSettingsCache?: Map<string, { value: unknown; expires: number }>;
  __tixSettingsInflight?: Map<string, Promise<unknown>>;
  __tixSettingsGuard?: { seq: number; floor: number; byKey: Map<string, number> };
};
const cache = (g.__tixSettingsCache ??= new Map<string, { value: unknown; expires: number }>());
/** Single-flight: concurrent readers of an expired entry share one DB query. */
const inflight = (g.__tixSettingsInflight ??= new Map<string, Promise<unknown>>());
/**
 * Invalidation sequence (same idea as TagCache): a load that started before an invalidation of
 * its key must not be stored, otherwise a stale value could outlive the invalidation by a TTL.
 */
const guard = (g.__tixSettingsGuard ??= { seq: 0, floor: 0, byKey: new Map<string, number>() });

function storeIfCurrent(cacheKey: string, startSeq: number, value: unknown): void {
  if (startSeq < guard.floor || (guard.byKey.get(cacheKey) ?? 0) > startSeq) return;
  cache.set(cacheKey, { value, expires: Date.now() + TTL_MS });
}

export async function getSetting<K extends SettingKey>(
  ctx: Pick<CoreContext, 'db'>,
  key: K,
): Promise<SettingValue<K>> {
  if (SETTINGS[key].secret)
    throw new Error(`Secret setting "${key}" must be read via the secret store`);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as SettingValue<K>;
  const pending = inflight.get(key);
  if (pending) return (await pending) as SettingValue<K>;
  const load = loadSetting(ctx, key);
  inflight.set(key, load);
  try {
    return await load;
  } finally {
    if (inflight.get(key) === load) inflight.delete(key);
  }
}

async function loadSetting<K extends SettingKey>(
  ctx: Pick<CoreContext, 'db'>,
  key: K,
): Promise<SettingValue<K>> {
  const startSeq = guard.seq;
  const [row] = await ctx.db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  let value: SettingValue<K>;
  try {
    value =
      row?.value === undefined || row.value === null
        ? defaultSetting(key)
        : parseSetting(key, row.value);
  } catch {
    // A stored value that no longer matches the schema falls back to defaults instead of
    // taking the shop down; the admin UI shows the validation error when editing.
    value = defaultSetting(key);
  }
  storeIfCurrent(key, startSeq, value);
  return value;
}

export async function saveSetting<K extends SettingKey>(
  ctx: Pick<CoreContext, 'publisher' | 'channels'> & { db: Executor },
  key: K,
  input: unknown,
  updatedByUserId: string | null,
): Promise<SettingValue<K>> {
  if (SETTINGS[key].secret)
    throw new Error(`Secret setting "${key}" must be written via the secret store`);
  const value = parseSetting(key, input);
  await ctx.db
    .insert(systemSettings)
    .values({ key, value, updatedByUserId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, encryptedValue: null, updatedByUserId, updatedAt: new Date() },
    });
  invalidateSettings(key);
  await ctx.publisher.publish(ctx.channels.configInvalidation(), JSON.stringify({ setting: key }));
  return value;
}

export function invalidateSettings(key?: string): void {
  guard.seq += 1;
  if (key) {
    // A change message names the setting; secret settings are cached under `secret:<key>`.
    for (const cacheKey of [key, `secret:${key}`]) {
      guard.byKey.set(cacheKey, guard.seq);
      cache.delete(cacheKey);
      inflight.delete(cacheKey);
    }
  } else {
    guard.floor = guard.seq;
    guard.byKey.clear();
    cache.clear();
    inflight.clear();
  }
}

/* ---------------------------------------------------------------------------------------
 * Secret settings (`secret: true` keys): stored encrypted in `encrypted_value`, never sent
 * back to the browser. The admin UI only learns whether a secret is configured.
 * ------------------------------------------------------------------------------------- */

const secretContext = (key: string) => `setting:${key}`;

function assertSecret(key: SettingKey): void {
  if (!SETTINGS[key].secret) throw new Error(`Setting "${key}" is not a secret setting`);
}

/** Decrypted secret setting, or null when it was never configured. */
export async function getSecretSetting<K extends SettingKey>(
  ctx: Pick<CoreContext, 'db' | 'secrets'>,
  key: K,
): Promise<SettingValue<K> | null> {
  assertSecret(key);
  const cacheKey = `secret:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value as SettingValue<K> | null;
  const startSeq = guard.seq;
  const [row] = await ctx.db
    .select({ encryptedValue: systemSettings.encryptedValue })
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  let value: SettingValue<K> | null = null;
  if (row?.encryptedValue) {
    if (!ctx.secrets) throw new Error('Core context capability "secrets" is not configured');
    value = parseSetting(key, ctx.secrets.decryptJson(row.encryptedValue, secretContext(key)));
  }
  storeIfCurrent(cacheKey, startSeq, value);
  return value;
}

export async function hasSecretSetting(
  ctx: Pick<CoreContext, 'db'>,
  key: SettingKey,
): Promise<boolean> {
  assertSecret(key);
  const [row] = await ctx.db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  return Boolean(row);
}

export async function saveSecretSetting<K extends SettingKey>(
  ctx: Pick<CoreContext, 'publisher' | 'channels' | 'secrets'> & { db: Executor },
  key: K,
  input: unknown,
  updatedByUserId: string | null,
): Promise<void> {
  assertSecret(key);
  if (!ctx.secrets) throw new Error('Core context capability "secrets" is not configured');
  const value = parseSetting(key, input);
  const encryptedValue = ctx.secrets.encryptJson(value, secretContext(key));
  await ctx.db
    .insert(systemSettings)
    .values({ key, value: null, encryptedValue, updatedByUserId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: null, encryptedValue, updatedByUserId, updatedAt: new Date() },
    });
  invalidateSettings(`secret:${key}`);
  await ctx.publisher.publish(ctx.channels.configInvalidation(), JSON.stringify({ setting: key }));
}

export async function clearSecretSetting(
  ctx: Pick<CoreContext, 'publisher' | 'channels'> & { db: Executor },
  key: SettingKey,
): Promise<void> {
  assertSecret(key);
  await ctx.db.delete(systemSettings).where(eq(systemSettings.key, key));
  invalidateSettings(`secret:${key}`);
  await ctx.publisher.publish(ctx.channels.configInvalidation(), JSON.stringify({ setting: key }));
}
