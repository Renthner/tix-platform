import { MIN_POLL_INTERVAL } from '@tix/core';
import {
  POLLING_BANK_ADAPTERS,
  SUPPORTED_BANK_ADAPTERS,
  finApiStateSchema,
  finTsStateSchema,
  imapStateSchema,
  type SupportedBankAdapter,
} from '@tix/shared';
import { ArrowLeft } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { BankingConfirm } from '@/components/admin/banking/account-form';
import { AutoRefresh, SyncStatusBadge } from '@/components/admin/banking/banking-ui';
import {
  BankingActionButton,
  FinApiConnectButton,
} from '@/components/admin/banking/connection-actions';
import { ConnectionForm } from '@/components/admin/banking/connection-form';
import { TanChallenges } from '@/components/admin/banking/tan-challenges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
  deleteBankConnectionAction,
  finApiConnectAction,
  finApiRefreshAction,
  saveBankConnectionAction,
  syncBankConnectionAction,
  testImapAction,
} from '@/server/admin/banking-actions';
import { getConnectionDetail } from '@/server/admin/banking-queries';

export default async function ConnectionPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t, tc, format, detail] = await Promise.all([
    getTranslations('banking'),
    getTranslations('common.actions'),
    getFormatter(),
    getConnectionDetail(id),
  ]);
  if (!detail) notFound();
  const { connection: c, account, runs, challenges, imports } = detail;
  if (!(SUPPORTED_BANK_ADAPTERS as readonly string[]).includes(c.adapter)) notFound();
  const adapter = c.adapter as SupportedBankAdapter;
  const config = c.config;
  if (config.adapter === 'PSD2_GOCARDLESS') notFound();
  const polling = (POLLING_BANK_ADAPTERS as readonly string[]).includes(adapter);
  const running = c.lastSyncStatus === 'RUNNING' || c.lastSyncStatus === 'TAN_REQUIRED';
  const dateTime = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' })
      : t('connection.status.never');
  const day = (iso: string | null) =>
    iso ? format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: 'short' }) : '';

  const fints = adapter === 'FINTS' ? finTsStateSchema.safeParse(c.state).data : undefined;
  const finapi = adapter === 'PSD2_FINAPI' ? finApiStateSchema.safeParse(c.state).data : undefined;
  const imap = adapter === 'IMAP' ? imapStateSchema.safeParse(c.state).data : undefined;
  const webFormOpen =
    finapi?.webForm &&
    ['NOT_YET_OPENED', 'IN_PROGRESS'].includes(finapi.webForm.status) &&
    new Date(finapi.webForm.expiresAt).getTime() > Date.now()
      ? finapi.webForm.url
      : null;

  const statusRows: [string, ReactNode][] = [
    [
      t('connection.status.lastSync'),
      <span key="s" className="flex flex-wrap items-center gap-2">
        <SyncStatusBadge status={c.lastSyncStatus} /> {c.lastSyncAt ? dateTime(c.lastSyncAt) : ''}
      </span>,
    ],
    [t('connection.status.lastSuccess'), dateTime(c.lastSuccessfulSyncAt)],
    [
      t('connection.status.nextSync'),
      !c.pollIntervalSeconds
        ? t('connection.status.manualOnly')
        : c.nextSyncAt
          ? dateTime(c.nextSyncAt)
          : t('connection.status.paused'),
    ],
  ];
  if (c.consentExpiresAt)
    statusRows.push([t('connection.status.consent'), dateTime(c.consentExpiresAt)]);
  if (imap?.lastCheckedAt)
    statusRows.push([t('connection.imap.lastChecked'), dateTime(new Date(imap.lastCheckedAt))]);

  return (
    <>
      <AutoRefresh active={running || challenges.length > 0} />
      <Button asChild variant="ghost" size="sm">
        <Link href={`/admin/banking/accounts/${account.id}`}>
          <ArrowLeft /> {t('connection.backToAccount')}
        </Link>
      </Button>
      <TanChallenges challenges={challenges} />

      <Card className="max-w-4xl">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {c.name}
              {c.isActive ? null : <Badge variant="outline">{t('accounts.inactive')}</Badge>}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(`adapter.${adapter}`)} · {account.name}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            {polling ? (
              <BankingActionButton
                action={syncBankConnectionAction.bind(null, c.id)}
                label={t('connection.actions.sync')}
                variant="default"
                icon="refresh"
                disabled={running || !c.isActive}
              />
            ) : (
              <Button asChild size="sm">
                <Link href={`/admin/banking/imports?account=${account.id}`}>
                  {t('connection.actions.uploadFiles')}
                </Link>
              </Button>
            )}
            {adapter === 'IMAP' ? (
              <BankingActionButton
                action={testImapAction.bind(null, c.id)}
                label={t('connection.actions.testImap')}
              />
            ) : null}
            <BankingConfirm
              action={deleteBankConnectionAction.bind(null, c.id, account.id)}
              title={t('connection.actions.deleteTitle')}
              description={t('connection.actions.deleteDescription')}
              confirmLabel={tc('delete')}
            >
              {t('connection.actions.delete')}
            </BankingConfirm>
          </div>
        </CardHeader>
        {polling ? (
          <CardContent className="space-y-3">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[14rem_1fr]">
              {statusRows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {c.lastSyncStatus === 'FAILED' && c.lastError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {t('connection.status.lastError')}:{' '}
                  <span className="font-mono text-xs">{c.lastError}</span>
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      {fints ? (
        <Card className="max-w-4xl">
          <CardContent className="space-y-3 text-sm">
            {fints.setupIssue ? (
              <Alert>
                <AlertDescription>
                  {t(`connection.fints.setupIssue.${fints.setupIssue}`)}
                </AlertDescription>
              </Alert>
            ) : null}
            {fints.bankName ? (
              <div>
                <span className="text-muted-foreground">{t('connection.fints.bank')}:</span>{' '}
                {fints.bankName}
              </div>
            ) : null}
            {fints.accounts.length > 0 ? (
              <div>
                <div className="text-muted-foreground">{t('connection.fints.accounts')}</div>
                <ul className="mt-1 space-y-0.5 font-mono text-xs">
                  {fints.accounts.map((a) => (
                    <li key={`${a.iban}-${a.accountNumber}`}>
                      {a.iban ?? a.accountNumber} {a.product ? `· ${a.product}` : ''}{' '}
                      {a.currency ? `· ${a.currency}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {fints.bankMessages.length > 0 ? (
              <div>
                <div className="text-muted-foreground">{t('connection.fints.bankMessages')}</div>
                {fints.bankMessages.map((m, i) => (
                  <p key={i} className="mt-1">
                    <span className="font-medium">{m.subject}</span> {m.text}
                  </p>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {finapi ? (
        <Card className="max-w-4xl">
          <CardHeader>
            <CardTitle>{t('connection.finapi.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {finapi.bankConnectionId ? (
              <div className="space-y-1">
                <div>
                  <Badge>{t('connection.finapi.connected')}</Badge>{' '}
                  {finapi.bankName ? <span className="ml-1">{finapi.bankName}</span> : null}
                </div>
                <div className="text-muted-foreground">
                  {t('connection.finapi.bankConnection')} #{finapi.bankConnectionId}
                  {finapi.accountId
                    ? ` · ${t('connection.finapi.account')} #${finapi.accountId}`
                    : ''}
                </div>
                {!finapi.accountId && finapi.accounts.length > 0 ? (
                  <p className="text-destructive">
                    {t('connection.finapi.accountNotFound', {
                      ibans: finapi.accounts.map((a) => a.iban ?? `#${a.id}`).join(', '),
                    })}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">{t('connection.finapi.notConnected')}</p>
            )}
            {finapi.userActionRequired ? (
              <Alert variant="destructive">
                <AlertDescription>{t('connection.finapi.userActionRequired')}</AlertDescription>
              </Alert>
            ) : null}
            {finapi.webForm ? (
              <p className="text-xs text-muted-foreground">
                {t('connection.finapi.webFormStatus', { status: finapi.webForm.status })}
              </p>
            ) : null}
            {finapi.lastErrorCode ? (
              <p className="text-xs text-destructive">
                {t('connection.finapi.lastError', { code: finapi.lastErrorCode })}
              </p>
            ) : null}
            <div className="flex flex-wrap items-start gap-2">
              <FinApiConnectButton
                action={finApiConnectAction.bind(null, c.id)}
                label={
                  finapi.bankConnectionId
                    ? t('connection.finapi.renew')
                    : t('connection.finapi.connect')
                }
                pendingUrl={webFormOpen}
              />
              {finapi.userId ? (
                <BankingActionButton
                  action={finApiRefreshAction.bind(null, c.id)}
                  label={t('connection.finapi.refresh')}
                  icon="refresh"
                />
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="max-w-4xl">
        <CardContent>
          <ConnectionForm
            adapter={adapter}
            action={saveBankConnectionAction.bind(null, account.id, c.id, adapter)}
            minPollMinutes={Math.ceil(
              (adapter === 'PSD2_FINAPI' &&
              config.adapter === 'PSD2_FINAPI' &&
              !config.backgroundUpdate
                ? 3600
                : MIN_POLL_INTERVAL[adapter]) / 60,
            )}
            tanMethods={fints?.tanMethods ?? []}
            submitLabel={tc('save')}
            initial={{
              name: c.name,
              isActive: c.isActive,
              pollIntervalSeconds: c.pollIntervalSeconds,
              config,
              hasSecrets: Boolean(c.credentialsEncrypted),
            }}
          />
        </CardContent>
      </Card>

      {polling ? (
        <Card className="max-w-4xl">
          <CardHeader>
            <CardTitle>{t('connection.runs.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('connection.runs.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('connection.runs.started')}</TableHead>
                    <TableHead>{t('connection.runs.trigger')}</TableHead>
                    <TableHead>{t('connection.runs.status')}</TableHead>
                    <TableHead>{t('connection.runs.period')}</TableHead>
                    <TableHead className="text-right">{t('connection.runs.fetched')}</TableHead>
                    <TableHead className="text-right">{t('connection.runs.imported')}</TableHead>
                    <TableHead className="text-right">{t('connection.runs.matched')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {format.dateTime(r.startedAt, { dateStyle: 'short', timeStyle: 'medium' })}
                      </TableCell>
                      <TableCell className="text-sm">{t(`trigger.${r.trigger}`)}</TableCell>
                      <TableCell>
                        <SyncStatusBadge status={r.status} />
                        {r.errorMessage ? (
                          <div className="max-w-sm break-words font-mono text-xs text-destructive">
                            {r.errorMessage}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {r.periodFrom ? `${day(r.periodFrom)} – ${day(r.periodTo)}` : '–'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.fetchedCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.importedCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.matchedCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {imports.length > 0 ? (
        <Card className="max-w-4xl">
          <CardHeader>
            <CardTitle>{t('imports.history')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {imports.map((file) => (
                <li key={file.id} className="flex flex-wrap justify-between gap-2">
                  <a
                    href={`/api/admin/banking/imports/${file.id}`}
                    className="break-all hover:underline"
                  >
                    {file.fileName}
                  </a>
                  <span className="text-muted-foreground">
                    {t(`importStatus.${file.status}`)} · {file.importedCount}/
                    {file.transactionCount} ·{' '}
                    {format.dateTime(file.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
