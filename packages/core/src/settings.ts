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
