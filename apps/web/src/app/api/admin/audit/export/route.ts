import { buildCsv, listAuditLogsForExport, redactAuditValue } from '@tix/core';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { audit } from '@/server/admin/audit';
import { parseAuditFilter } from '@/server/audit-filter';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET – CSV of the filtered audit trail (SUPER_ADMIN; capped; formula-injection safe). */
export async function GET(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['SUPER_ADMIN']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
    const locale = hasLocale(routing.locales, sp.locale) ? sp.locale : routing.defaultLocale;
    const t = await getTranslations({ locale, namespace: 'audit' });
    const core = getCore();
    const { rows, truncated } = await listAuditLogsForExport(core, parseAuditFilter(sp));
    const json = (v: unknown) => (v == null ? '' : JSON.stringify(redactAuditValue(v)));
    const csv = buildCsv(
      t.raw('csv.header') as string[],
      rows.map((r) => [
        r.createdAt.toISOString(),
        r.actorType,
        r.actorEmail ?? r.actorName ?? r.actorDeviceId ?? '',
        r.action,
        r.entityType,
        r.entityId,
        r.ipAddress,
        json(r.changes),
        json(r.metadata),
      ]),
    );
    await audit(core.db, session, 'audit.export', 'audit_log', null, {
      rows: rows.length,
      truncated,
    });
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="audit-log.csv"',
        'cache-control': 'no-store',
        ...(truncated ? { 'x-tix-truncated': '1' } : {}),
      },
    });
  });
}
