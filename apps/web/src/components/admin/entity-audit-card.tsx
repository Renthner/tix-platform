import { listAuditLogs } from '@tix/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { getCore } from '@/server/core';

/**
 * History of one entity from the audit log (who did what and when), newest first. Server component:
 * the page that renders it has already checked that the viewer may see the entity. Only action,
 * actor and time are shown (no change details); the full log (with details) is a SUPER_ADMIN page,
 * linked when `showFullLogLink` is set.
 */
export async function EntityAuditCard({
  entityType,
  entityId,
  limit = 10,
  showFullLogLink = false,
  bare = false,
}: {
  entityType: string;
  entityId: string;
  limit?: number;
  showFullLogLink?: boolean;
  /** Only the list (no card), e.g. inside the order page's activity tabs. */
  bare?: boolean;
}) {
  const [t, format, { rows, total }] = await Promise.all([
    getTranslations('audit.entityCard'),
    getFormatter(),
    listAuditLogs(getCore(), { entityType, entityId }, { pageSize: limit }),
  ]);
  const Frame = bare ? BareFrame : CardFrame;
  return (
    <Frame title={t('title')}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
              <span className="font-mono text-xs">{row.action}</span>
              <span className="text-muted-foreground">
                {row.actorName ?? t('system')} ·{' '}
                {format.dateTime(row.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {showFullLogLink && total > 0 && (
        <p className="mt-3 text-sm">
          <Link
            href={`/admin/audit?entityType=${encodeURIComponent(entityType)}&q=${encodeURIComponent(entityId)}`}
            className="underline"
          >
            {t('viewAll', { count: total })}
          </Link>
        </p>
      )}
    </Frame>
  );
}

function CardFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card data-testid="entity-audit-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function BareFrame({ children }: { title: string; children: ReactNode }) {
  return <div data-testid="entity-audit-card">{children}</div>;
}
