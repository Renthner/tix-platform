import { parseAuditDate, type AuditLogFilter } from '@tix/core';
import { ACTOR_TYPES, type ActorType } from '@tix/shared';

/** Audit filter from raw URL query values (page and export share it). `to` is an inclusive day. */
export function parseAuditFilter(sp: Record<string, string | undefined>): AuditLogFilter {
  const from = parseAuditDate(sp.from);
  const toDay = parseAuditDate(sp.to);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    q: sp.q?.trim().slice(0, 100) || undefined,
    actionPrefix: sp.action?.trim().slice(0, 100) || undefined,
    entityType: sp.entityType?.trim().slice(0, 100) || undefined,
    actorUserId: sp.actor && uuid.test(sp.actor) ? sp.actor : undefined,
    actorType: (ACTOR_TYPES as readonly string[]).includes(sp.actorType ?? '')
      ? (sp.actorType as ActorType)
      : undefined,
    from,
    to: toDay ? new Date(toDay.getTime() + 86_400_000) : undefined,
  };
}
