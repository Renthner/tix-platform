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
const cache = new Map<string, { value: unknown; expires: number }>();

export async function getSetting<K extends SettingKey>(
  ctx: Pick<CoreContext, 'db'>,
  key: K,
): Promise<SettingValue<K>> {
  if (SETTINGS[key].secret)
    throw new Error(`Secret setting "${key}" must be read via the secret store`);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as SettingValue<K>;
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
  cache.set(key, { value, expires: Date.now() + TTL_MS });
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
  if (key) cache.delete(key);
  else cache.clear();
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
  const [row] = await ctx.db
    .select({ encryptedValue: systemSettings.encryptedValue })
    .from(systemSettings)
    .where(eq(systemSettings.key, key));
  let value: SettingValue<K> | null = null;
  if (row?.encryptedValue) {
    if (!ctx.secrets) throw new Error('Core context capability "secrets" is not configured');
    value = parseSetting(key, ctx.secrets.decryptJson(row.encryptedValue, secretContext(key)));
  }
  cache.set(cacheKey, { value, expires: Date.now() + TTL_MS });
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
