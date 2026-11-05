import 'server-only';
import { auditLogs, type Executor } from '@tix/db';
import type { AdminSession } from '@/server/auth';

/** Appends an audit trail entry for an administrative mutation (GoBD traceability). */
export async function audit(
  db: Executor,
  session: AdminSession,
  action: string,
  entityType: string,
  entityId: string | null,
  changes?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLogs).values({
    actorType: 'ADMIN',
    actorUserId: session.userId,
    action,
    entityType,
    entityId,
    changes: changes ?? null,
  });
}
