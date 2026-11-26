import {
  countAdminPasskeys,
  countBackupsUsingKeys,
  getReEncryptPending,
  getSecretsUnreadable,
  passkeysAvailable,
  getBackupFailure,
  getRestoreIncomplete,
  getSetting,
  hasSecretSetting,
  foreignBackupKeysAllowed,
  listCatalogue,
  readProbeHistory,
} from '@tix/core';
import { auditLogs } from '@tix/db';
import { keyLabel, loadExtraKeys, type SecretBoxKey } from '@tix/shared/server';
import { desc, eq } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BackupSettingsForm } from '@/components/admin/backups/backup-settings-form';
import { DatabaseBackup } from 'lucide-react';
import {
  BackupNowButton,
  BackupRowActions,
  BackupStatusPanel,
  DismissNoticeButton,
  ProbeNowButton,
  ReEncryptButton,
  RestoreButton,
  UploadBackupButton,
} from '@/components/admin/backups/backups-ui';
import { DetailLayout } from '@/components/admin/detail-layout';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminPageHeader } from '@/components/admin/page-header';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { SettingsSection } from '@/components/admin/settings-forms';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import {
  backupNowAction,
  deleteBackupAction,
  dismissReEncryptPendingAction,
  recheckSecretsAction,
  previewRestoreAction,
  probeNowAction,
  reEncryptNowAction,
  restoreBackupAction,
  saveBackupSettingsAction,
  testBackupTargetAction,
  verifyBackupAction,
} from '@/server/admin/backups';
import { getBackupBuckets, getStorageInfo } from '@/server/backups';
import { getCore } from '@/server/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('backups');
  return { title: t('title') };
}

const formatSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

export default async function BackupsPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const session = await requireAdmin(['SUPER_ADMIN'], { allowIncompleteRestore: true });
  const core = getCore();
  const [
    t,
    tv,
    format,
    entries,
    settings,
    credentialsStored,
    general,
    failure,
    incomplete,
    probes,
    unreadableSecrets,
    reEncryptPending,
  ] = await Promise.all([
    getTranslations('backups'),
    getTranslations('backups.verifyDetail'),
    getFormatter(),
    listCatalogue(getBackupBuckets().backups),
    getSetting(core, 'backup'),
    hasSecretSetting(core, 'backup.external.credentials'),
    getSetting(core, 'general'),
    getBackupFailure(core),
    getRestoreIncomplete(core),
    readProbeHistory(getBackupBuckets().backups),
    getSecretsUnreadable(core),
    getReEncryptPending(core),
  ]);
  const storage = getStorageInfo();
  const lastProbe = probes[0] ?? null;
  const keyId = core.secrets?.activeKeyId ?? '';
  // Standalone re-encryption: same second factor as a restore; last run from the audit trail.
  const [account, passkeyCount, [lastReEncrypt]] = await Promise.all([
    core.db.query.adminUsers.findFirst({
      columns: { totpSecretEncrypted: true },
      where: (u, { eq: equals }) => equals(u.id, session.userId),
    }),
    countAdminPasskeys(core, session.userId),
    core.db
      .select({ at: auditLogs.createdAt, changes: auditLogs.changes })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'secrets.reencrypt'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1),
  ]);
  const lastRun = lastReEncrypt?.changes as
    | {
        complete: boolean;
        removedKeyIds: string[];
        remainingForeign: number;
        tables: { id: string; reEncrypted: number; skipped: number; undecryptable: number }[];
        undecryptable: { id: string; pk: string }[];
      }
    | undefined;
  // Ids only: keys of another system that a restore stored as additional decrypt-only keys.
  let additionalKeyIds: string[] = [];
  let additionalKeys: SecretBoxKey[] = [];
  try {
    additionalKeys = loadExtraKeys();
    additionalKeyIds = additionalKeys.map(keyLabel);
  } catch {
    /* an unreadable file is reported at startup */
  }
  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: general.defaultTimeZone,
    });
  const verifyReason = (detail: string | undefined) => {
    const code = detail?.split(':')[0] ?? '';
    return code && tv.has(code as 'CORRUPT') ? tv(code as 'CORRUPT') : (detail ?? '');
  };

  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('administration')}
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <UploadBackupButton foreignKeysAllowed={foreignBackupKeysAllowed()} />
            <BackupNowButton action={backupNowAction} />
          </>
        }
      />
      <div className="max-w-7xl">
        <div className="space-y-4 px-6 pt-6 empty:hidden">
          {failure && (
            <Alert variant="destructive">
              <AlertTitle>{t('dashboardAlert.title')}</AlertTitle>
              <AlertDescription>
                {t('dashboardAlert.text', { message: failure.message })}
              </AlertDescription>
            </Alert>
          )}
          {unreadableSecrets && (
            <Alert variant="destructive">
              <AlertTitle>{t('unreadableSecrets.title')}</AlertTitle>
              <AlertDescription>
                {t('unreadableSecrets.text', { count: unreadableSecrets.count })}
                <div className="mt-3">
                  <DismissNoticeButton
                    action={recheckSecretsAction}
                    label={t('unreadableSecrets.recheck')}
                  />
                </div>
              </AlertDescription>
            </Alert>
          )}
          {reEncryptPending && (
            <Alert className="border-warning-border bg-warning-soft text-warning">
              <AlertTitle>{t('reencryptPending.title')}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {t(
                    reEncryptPending.gaveUp
                      ? 'reencryptPending.textGaveUp'
                      : 'reencryptPending.text',
                  )}
                </p>
                <DismissNoticeButton
                  action={dismissReEncryptPendingAction}
                  label={t('reencryptPending.dismiss')}
                />
              </AlertDescription>
            </Alert>
          )}
          {incomplete && (
            <Alert variant="destructive">
              <AlertTitle>{t('incomplete.title')}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{t('incomplete.text', { step: incomplete.step })}</p>
                {incomplete.error && (
                  <p className="text-xs">{t('incomplete.error', { error: incomplete.error })}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {incomplete.backupId && (
                    <RestoreButton
                      backupId={incomplete.backupId}
                      createdAtLabel={when(incomplete.at)}
                      preview={previewRestoreAction}
                      restore={restoreBackupAction}
                      label={t('incomplete.retry')}
                    />
                  )}
                  {incomplete.safetyBackupId && (
                    <RestoreButton
                      backupId={incomplete.safetyBackupId}
                      createdAtLabel={when(incomplete.at)}
                      preview={previewRestoreAction}
                      restore={restoreBackupAction}
                      label={t('incomplete.safety')}
                    />
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
          {storage.driver === 'fs' && !settings.externalEnabled && (
            <Alert className="border-warning-border bg-warning-soft text-warning">
              <AlertTitle>{t('storage.localOnlyTitle')}</AlertTitle>
              <AlertDescription>{t('storage.localOnlyText')}</AlertDescription>
            </Alert>
          )}
          <BackupStatusPanel foreignKeysAllowed={foreignBackupKeysAllowed()} />
          {additionalKeyIds.length > 0 && (
            <Alert>
              <AlertTitle>{t('additionalKeys.title')}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{t('additionalKeys.text', { ids: additionalKeyIds.join(', ') })}</p>
                <ReEncryptButton
                  action={reEncryptNowAction}
                  twoFactor={Boolean(account?.totpSecretEncrypted) || passkeyCount > 0}
                  passkeys={passkeyCount > 0 && passkeysAvailable(core)}
                  backupsUsingKeys={countBackupsUsingKeys(
                    entries.map((e) => e.manifest),
                    additionalKeys,
                  )}
                  backupsUnchecked={entries.filter((e) => !e.manifest.secretKeys).length}
                />
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DetailLayout
          aside={
            <>
              <SettingsSection id="storage" title={t('storage.title')}>
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>
                    {storage.driver === 'fs'
                      ? t('storage.driverFs', { dir: storage.dir ?? '' })
                      : t('storage.driverS3')}
                  </p>
                  <p>{t('keyNote', { keyId })}</p>
                  <p>{t('upload.hint')}</p>
                </div>
                {lastRun && lastReEncrypt && (
                  <div className="space-y-1 rounded-lg border p-4 text-sm">
                    <p className="font-medium">
                      {t('reencrypt.last.title')} · {when(lastReEncrypt.at.toISOString())}
                    </p>
                    <p className={lastRun.complete ? 'text-success' : 'text-destructive'}>
                      {lastRun.complete
                        ? t('reencrypt.last.complete', {
                            keys: lastRun.removedKeyIds.join(', ') || '-',
                          })
                        : t('reencrypt.last.incomplete', { remaining: lastRun.remainingForeign })}
                    </p>
                    <ul className="list-disc pl-5 text-xs text-muted-foreground">
                      {lastRun.tables.map((row) => (
                        <li key={row.id}>
                          {t('reencrypt.last.table', {
                            table: row.id,
                            reEncrypted: row.reEncrypted,
                            skipped: row.skipped,
                            unreadable: row.undecryptable,
                          })}
                        </li>
                      ))}
                      {lastRun.undecryptable.map((row) => (
                        <li key={`${row.id}:${row.pk}`} className="text-destructive">
                          {t('reencrypt.last.unreadableRow', { table: row.id, pk: row.pk })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </SettingsSection>
            </>
          }
        >
          <SettingsSection id="backupList" title={t('list.title')}>
            {entries.length === 0 ? (
              <EmptyState
                icon={DatabaseBackup}
                size="sm"
                title={t('list.empty')}
                data-testid="backups-empty"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('list.columns.date')}</TableHead>
                    <TableHead>{t('list.columns.kind')}</TableHead>
                    <TableHead className="text-right">{t('list.columns.size')}</TableHead>
                    <TableHead>{t('list.columns.external')}</TableHead>
                    <TableHead>{t('list.columns.verify')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('list.columns.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map(({ manifest, state }) => (
                    <TableRow key={manifest.id}>
                      <TableCell className="align-top">
                        <div className="whitespace-nowrap font-medium">
                          {when(manifest.createdAt)}
                        </div>
                        <div className="max-w-sm text-xs text-muted-foreground">
                          {manifest.scope === 'DATABASE'
                            ? t('list.detailsDatabaseOnly', {
                                orders: manifest.rowCounts.orders ?? 0,
                                migration:
                                  manifest.lastMigration.tag ?? manifest.lastMigration.count,
                                version: manifest.appVersion,
                              })
                            : t('list.details', {
                                orders: manifest.rowCounts.orders ?? 0,
                                assets: manifest.files?.assets.objects ?? 0,
                                documents: manifest.files?.documents.objects ?? 0,
                                migration:
                                  manifest.lastMigration.tag ?? manifest.lastMigration.count,
                              })}
                          {manifest.originalId ? ` · ${t('list.uploaded')}` : ''}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant={
                            manifest.kind === 'PRE_RESTORE' || manifest.kind === 'PRE_UPDATE'
                              ? 'outline'
                              : 'secondary'
                          }
                        >
                          {t(`list.kind.${manifest.kind}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                        {formatSize(manifest.archive?.sizeBytes ?? 0)}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant={state.external.status === 'FAILED' ? 'destructive' : 'outline'}
                        >
                          {t(`list.external.${state.external.status}`)}
                        </Badge>
                        {state.external.error && (
                          <div className="mt-1 max-w-xs text-xs text-destructive">
                            {state.external.error}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        {state.verify ? (
                          <>
                            <Badge
                              variant={state.verify.status === 'OK' ? 'secondary' : 'destructive'}
                            >
                              {t(`list.verify.${state.verify.status}`, {
                                date: when(state.verify.at),
                              })}
                            </Badge>
                            {state.verify.status === 'FAILED' && (
                              <div className="mt-1 max-w-xs text-xs text-destructive">
                                {verifyReason(state.verify.detail)}
                                {state.verify.mismatches?.map((m) => (
                                  <div key={m}>{m}</div>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t('list.verify.NONE')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex items-center justify-end gap-1.5">
                          <RestoreButton
                            backupId={manifest.id}
                            createdAtLabel={when(manifest.createdAt)}
                            databaseOnly={manifest.scope === 'DATABASE'}
                            preview={previewRestoreAction}
                            restore={restoreBackupAction}
                          />
                          <BackupRowActions
                            id={manifest.id}
                            label={t('list.rowActions', { date: when(manifest.createdAt) })}
                            verify={verifyBackupAction.bind(null, manifest.id)}
                            remove={deleteBackupAction.bind(null, manifest.id)}
                            hasExternalCopy={state.external.status === 'UPLOADED'}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsSection>

          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1">
                  <h2 className="text-sm font-medium">{t('probe.title')}</h2>
                  <p className="max-w-2xl text-xs text-muted-foreground">
                    {t('probe.description')}
                  </p>
                </div>
                <ProbeNowButton action={probeNowAction} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {!settings.probeEnabled && <Badge variant="outline">{t('probe.off')}</Badge>}
                {lastProbe ? (
                  <>
                    <Badge variant={lastProbe.status === 'OK' ? 'secondary' : 'destructive'}>
                      {t(`probe.status.${lastProbe.status}`, { date: when(lastProbe.finishedAt) })}
                    </Badge>
                    {lastProbe.status === 'FAILED' && (
                      <span className="text-xs text-destructive">
                        {verifyReason(lastProbe.error)}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('probe.never')}</span>
                )}
              </div>
              {probes.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('probe.columns.date')}</TableHead>
                      <TableHead>{t('probe.columns.result')}</TableHead>
                      <TableHead>{t('probe.columns.backup')}</TableHead>
                      <TableHead className="text-right">{t('probe.columns.duration')}</TableHead>
                      <TableHead>{t('probe.columns.details')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {probes.slice(0, 10).map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="whitespace-nowrap align-top">
                          {when(p.startedAt)}
                          <div className="text-xs text-muted-foreground">
                            {t(`probe.trigger.${p.trigger}`)}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant={p.status === 'OK' ? 'secondary' : 'destructive'}>
                            {t(`probe.result.${p.status}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap align-top">
                          {p.backupCreatedAt ? when(p.backupCreatedAt) : '–'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                          {t('probe.seconds', {
                            seconds: Math.max(1, Math.round(p.durationMs / 1000)),
                          })}
                        </TableCell>
                        <TableCell className="align-top text-xs">
                          {p.status === 'OK' ? (
                            <span className="text-muted-foreground">
                              {t('probe.counts', {
                                events: p.counts?.events ?? 0,
                                orders: p.counts?.orders ?? 0,
                                tickets: p.counts?.tickets ?? 0,
                                migrations: p.migrationsApplied ?? 0,
                              })}
                            </span>
                          ) : (
                            <span className="text-destructive">
                              {verifyReason(p.error)}
                              {p.mismatches?.map((m) => (
                                <div key={m}>{m}</div>
                              ))}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <SettingsSection
            id="backupSettings"
            title={t('settings.title')}
            description={t('settings.description', { timeZone: general.defaultTimeZone })}
          >
            <BackupSettingsForm
              action={saveBackupSettingsAction}
              testAction={testBackupTargetAction}
              initial={settings}
              credentialsStored={credentialsStored}
            />
          </SettingsSection>
        </DetailLayout>
      </div>
    </>
  );
}
