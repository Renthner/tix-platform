import 'server-only';
import { DomainError } from '@tix/core';
import { readMaintenance } from './maintenance-gate';

/**
 * Throws a 503 DomainError while a restore is running or unfinished. Called at the start of
 * `handle()` (route handlers) and by `requireAdmin()` (server actions / pages). With
 * `allowIncompleteRestore` the call passes when ONLY the "restore incomplete" marker is set, so
 * the backup API and backup actions can finish or undo the restore. NOTE: the probe fails open
 * when Redis is unreachable.
 */
export async function assertNotInMaintenance(
  options: { allowIncompleteRestore?: boolean } = {},
): Promise<void> {
  const state = await readMaintenance();
  if (!state.active) return;
  if (state.incompleteOnly && options.allowIncompleteRestore) return;
  throw new DomainError(
    'MAINTENANCE',
    'The system is being restored. Please try again shortly.',
    503,
  );
}
