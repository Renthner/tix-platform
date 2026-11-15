import { keyFingerprint, type SecretBoxKey } from '@tix/shared/server';
import type { BackupManifest } from './manifest';

/**
 * Backup manifests list the key fingerprints their stored secrets depend on (`secretKeys`, written
 * at backup time, optional: older manifests have none). These helpers compare them with the keys a
 * system has – to warn before a restore and before additional keys are removed.
 */

/** `<keyId>:<8 hex>` entry of a key, the format of `manifest.secretKeys`. */
export const secretKeyEntry = (key: SecretBoxKey): string => `${key.id}:${keyFingerprint(key)}`;

/** Entries of the manifest whose key is NOT in `ring` (entries marked unreadable at backup time excluded). */
export function secretKeysMissingFrom(
  manifest: Pick<BackupManifest, 'secretKeys'>,
  ring: readonly SecretBoxKey[],
): string[] {
  const have = new Set(ring.map(secretKeyEntry));
  return (manifest.secretKeys ?? []).filter((e) => !e.endsWith(':unreadable') && !have.has(e));
}

/** Number of backups whose manifest names at least one of `keys` (the keys about to be removed). */
export function countBackupsUsingKeys(
  manifests: readonly Pick<BackupManifest, 'secretKeys'>[],
  keys: readonly SecretBoxKey[],
): number {
  const wanted = new Set(keys.map(secretKeyEntry));
  return manifests.filter((m) => (m.secretKeys ?? []).some((e) => wanted.has(e))).length;
}
