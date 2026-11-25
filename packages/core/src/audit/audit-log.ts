import { adminUsers, auditLogs } from '@tix/db';
import { ACTOR_TYPES, type ActorType } from '@tix/shared';
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { CoreContext } from '../context';

/**
 * Read side of the append-only audit trail (`audit_logs`): filtered, paged list for the admin
 * page and a capped export. Display helpers redact secret-looking keys; the table itself is
 * never modified here.
 */

export const AUDIT_PAGE_SIZE_MAX = 200;
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

export interface AuditLogFilter {
  /** Free text: action, entity id or actor e-mail / display name (substring, case-insensitive). */
  q?: string;
  /** Action prefix, e.g. `order.` matches `order.refund`. */
  actionPrefix?: string;
  entityType?: string;
  /** Exact entity id (with `entityType`: the history of one entity). */
  entityId?: string;
  actorUserId?: string;
  actorType?: ActorType;
  /** Inclusive lower bound (UTC instant). */
  from?: Date;
  /** Exclusive upper bound (UTC instant). */
  to?: Date;
}

export interface AuditLogRow {
  id: string;
  createdAt: Date;
  actorType: ActorType;
  actorUserId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  actorDeviceId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: unknown;
  metadata: unknown;
  ipAddress: string | null;
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function buildWhere(filter: AuditLogFilter): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  const q = filter.q?.trim().slice(0, 100);
  if (q) {
    conds.push(
      or(
        ilike(auditLogs.action, likePattern(q)),
        ilike(auditLogs.entityId, likePattern(q)),
        ilike(adminUsers.email, likePattern(q)),
        ilike(adminUsers.displayName, likePattern(q)),
      ),
    );
  }
  const prefix = filter.actionPrefix?.trim().slice(0, 100);
  if (prefix) conds.push(sql`starts_with(${auditLogs.action}, ${prefix})`);
  if (filter.entityType?.trim()) conds.push(eq(auditLogs.entityType, filter.entityType.trim()));
  if (filter.entityId) conds.push(eq(auditLogs.entityId, filter.entityId));
  if (filter.actorUserId) conds.push(eq(auditLogs.actorUserId, filter.actorUserId));
  if (filter.actorType && (ACTOR_TYPES as readonly string[]).includes(filter.actorType)) {
    conds.push(eq(auditLogs.actorType, filter.actorType));
  }
  if (filter.from) conds.push(gte(auditLogs.createdAt, filter.from));
  if (filter.to) conds.push(lt(auditLogs.createdAt, filter.to));
  return conds.length ? and(...conds) : undefined;
}

const selectRows = (ctx: Pick<CoreContext, 'db'>) =>
  ctx.db
    .select({
      id: auditLogs.id,
      createdAt: auditLogs.createdAt,
      actorType: auditLogs.actorType,
      actorUserId: auditLogs.actorUserId,
      actorEmail: adminUsers.email,
      actorName: adminUsers.displayName,
      actorDeviceId: auditLogs.actorDeviceId,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      changes: auditLogs.changes,
      metadata: auditLogs.metadata,
      ipAddress: sql<string | null>`host(${auditLogs.ipAddress})`,
    })
    .from(auditLogs)
    .leftJoin(adminUsers, eq(adminUsers.id, auditLogs.actorUserId));

/** One page (newest first) plus the total number of matching entries. */
export async function listAuditLogs(
  ctx: Pick<CoreContext, 'db'>,
  filter: AuditLogFilter,
  paging: { page?: number; pageSize?: number } = {},
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.trunc(paging.pageSize ?? 50), 1), AUDIT_PAGE_SIZE_MAX);
  const page = Math.max(Math.trunc(paging.page ?? 1), 1);
  const where = buildWhere(filter);
  const [rows, totalRows] = await Promise.all([
    selectRows(ctx)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .leftJoin(adminUsers, eq(adminUsers.id, auditLogs.actorUserId))
      .where(where),
  ]);
  return { rows, total: totalRows[0]?.n ?? 0 };
}

/** Up to `AUDIT_EXPORT_MAX_ROWS` matching entries, newest first; `truncated` if more exist. */
export async function listAuditLogsForExport(
  ctx: Pick<CoreContext, 'db'>,
  filter: AuditLogFilter,
): Promise<{ rows: AuditLogRow[]; truncated: boolean }> {
  const rows = await selectRows(ctx)
    .where(buildWhere(filter))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(AUDIT_EXPORT_MAX_ROWS + 1);
  return {
    rows: rows.slice(0, AUDIT_EXPORT_MAX_ROWS),
    truncated: rows.length > AUDIT_EXPORT_MAX_ROWS,
  };
}

/** Distinct entity types and action prefixes (first dotted segment) for the filter dropdowns. */
export async function listAuditFilterOptions(
  ctx: Pick<CoreContext, 'db'>,
): Promise<{ entityTypes: string[]; actionPrefixes: string[] }> {
  const [types, prefixes] = await Promise.all([
    ctx.db
      .selectDistinct({ v: auditLogs.entityType })
      .from(auditLogs)
      .orderBy(auditLogs.entityType)
      .limit(200),
    ctx.db
      .selectDistinct({ v: sql<string>`split_part(${auditLogs.action}, '.', 1)` })
      .from(auditLogs)
      .limit(200),
  ]);
  return {
    entityTypes: types.map((r) => r.v),
    actionPrefixes: prefixes.map((r) => r.v).sort(),
  };
}

const SECRET_KEY =
  /pass(word|phrase)?|token|secret|api[-_]?key|authorization|credential|\bpin\b|private[-_]?key|totp|cookie/i;
/** Whole words inside a key (camelCase / snake_case split): `fintsPin`, `pinCode`, `recovery_codes`. */
const SECRET_WORD = /(^|[^a-z])(pin|tan|otp|recovery|iban)([^a-z]|$)/i;
export const REDACTED = '[redacted]';

const isSecretKey = (key: string): boolean =>
  SECRET_KEY.test(key) || SECRET_WORD.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));

/** Deep copy with the values of secret-looking keys replaced (display and export only). */
export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactAuditValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redactAuditValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Admin users that appear as actors, for the actor filter. */
export async function listAuditActors(
  ctx: Pick<CoreContext, 'db'>,
): Promise<{ id: string; label: string }[]> {
  const rows = await ctx.db
    .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.displayName })
    .from(adminUsers)
    .where(
      sql`exists (select 1 from ${auditLogs} where ${auditLogs.actorUserId} = ${adminUsers.id})`,
    )
    .orderBy(adminUsers.email)
    .limit(500);
  return rows.map((r) => ({ id: r.id, label: `${r.name} <${r.email}>` }));
}

/** `YYYY-MM-DD` → UTC midnight, or undefined for anything else. */
export function parseAuditDate(raw: string | undefined | null): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
