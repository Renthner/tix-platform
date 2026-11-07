import { maskIban } from '@tix/shared';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AutoRefresh, SyncStatusBadge } from '@/components/admin/banking/banking-ui';
import { TanChallenges } from '@/components/admin/banking/tan-challenges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import {
  bankingStats,
  listConnections,
  listImports,
  pendingTanChallenges,
} from '@/server/admin/banking-queries';

export default async function BankingOverviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const [t, format, stats, connections, challenges, imports] = await Promise.all([
    getTranslations('banking'),
    getFormatter(),
    bankingStats(),
    listConnections(),
    pendingTanChallenges(),
    listImports(1, 5),
  ]);
  const running = connections.some(
    (c) =>
      c.connection.lastSyncStatus === 'RUNNING' || c.connection.lastSyncStatus === 'TAN_REQUIRED',
  );
  const tiles = [
    {
      label: t('overview.review'),
      value: stats.review,
      href: '/admin/banking/review',
      alert: stats.review > 0,
    },
    {
      label: t('overview.unmatched'),
      value: stats.unmatched,
      href: '/admin/banking/transactions?status=UNMATCHED',
    },
    {
      label: t('overview.autoMatched'),
      value: stats.autoMatched,
      href: '/admin/banking/transactions?status=AUTO_MATCHED',
    },
    {
      label: t('overview.manuallyMatched'),
      value: stats.manuallyMatched,
      href: '/admin/banking/transactions?status=MANUALLY_MATCHED',
    },
  ];
  return (
    <>
      <AutoRefresh active={running || challenges.length > 0} />
      <TanChallenges challenges={challenges} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Link key={tile.label} href={tile.href} className="block">
            <Card className={tile.alert ? 'border-destructive/60' : undefined}>
              <CardContent>
                <div className="text-sm text-muted-foreground">{tile.label}</div>
                <div className="text-2xl font-semibold tabular-nums">{tile.value}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('overview.last30', { count: stats.matchedLast30Days })}
        {stats.review > 0 ? (
          <>
            {' · '}
            {t('overview.reviewSum', {
              amount: format.number(stats.reviewSum / 100, { style: 'currency', currency: 'EUR' }),
            })}
          </>
        ) : null}
      </p>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('overview.connections')}</CardTitle>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/banking/accounts">{t('overview.setUp')}</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('overview.noConnections')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('accounts.columns.name')}</TableHead>
                  <TableHead>{t('accounts.columns.iban')}</TableHead>
                  <TableHead>{t('connection.runs.status')}</TableHead>
                  <TableHead>{t('connection.status.lastSync')}</TableHead>
                  <TableHead>{t('connection.status.consent')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map(({ connection: c, accountName, iban }) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/admin/banking/connections/${c.id}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {t(`adapter.${c.adapter}`)} · {accountName}
                        {c.isActive ? '' : ` · ${t('accounts.inactive')}`}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{maskIban(iban)}</TableCell>
                    <TableCell>
                      {c.adapter === 'FILE_IMPORT' ? (
                        '–'
                      ) : (
                        <SyncStatusBadge status={c.lastSyncStatus} />
                      )}
                      {c.lastSyncStatus === 'FAILED' && c.lastError ? (
                        <div
                          className="max-w-xs truncate text-xs text-destructive"
                          title={c.lastError}
                        >
                          {c.lastError}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.lastSyncAt ? format.relativeTime(c.lastSyncAt) : '–'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.consentExpiresAt
                        ? format.dateTime(c.consentExpiresAt, { dateStyle: 'medium' })
                        : '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('overview.recentImports')}</CardTitle>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/banking/imports">{t('overview.allImports')}</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {imports.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('overview.noImports')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {imports.rows.map(({ file, accountName }) => (
                <li key={file.id} className="flex flex-wrap justify-between gap-2">
                  <span className="break-all">
                    {file.fileName} <span className="text-muted-foreground">· {accountName}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {t(`importStatus.${file.status}`)} · {file.importedCount}/
                    {file.transactionCount} ·{' '}
                    {format.dateTime(file.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
