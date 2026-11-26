'use client';

import {
  DatabaseBackup,
  Download,
  FlaskConical,
  KeyRound,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RowActions } from '@/components/admin/row-actions';
import {
  checkSourceKeysAction,
  reEncryptPasskeyOptionsAction,
  restorePasskeyOptionsAction,
  stageUploadKeysAction,
} from '@/server/admin/backups';
import {
  BACKUP_IDLE,
  type BackupActionState,
  type RestorePreview,
  type SourceKeyCheck,
} from '@/lib/backup-state';
import { ActionForm, Field, SubmitButton } from '../form-controls';

type OperationAction = () => Promise<BackupActionState>;

function useFeedback() {
  const t = useTranslations('backups.feedback');
  return (state: BackupActionState) => {
    if (state.status === 'success') toast.success(t(state.code));
    else if (state.status === 'error') toast.error(t(state.code, { detail: state.detail ?? '' }));
  };
}

// ─── Live status ─────────────────────────────────────────────────────────────────────

interface StatusResponse {
  status: {
    operation: 'BACKUP' | 'VERIFY' | 'RESTORE' | 'IMPORT' | 'PROBE' | 'REENCRYPT';
    state: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    step: string;
    startedAt: string;
    updatedAt: string;
    detail?: string;
    stale: boolean;
  } | null;
  maintenance: boolean;
}

/** Failures that mean "this backup was made by another system": the hint is shown right there. */
const OTHER_SYSTEM_STEPS = new Set([
  'IMPORT_KEY_UNKNOWN',
  'REJECTED_KEY_UNKNOWN',
  'IMPORT_KEYS_DISABLED',
  'REJECTED_KEYS_DISABLED',
]);

/**
 * Operator opt-in is off: shows exactly what to add to .env and how to apply it (a plain
 * `docker compose restart` does not re-read .env).
 */
export function ForeignKeysDisabledHint() {
  const t = useTranslations('backups.sourceKey.disabled');
  return (
    <div className="space-y-2 rounded-md border border-warning-border bg-warning-soft p-3 text-sm text-warning">
      <p className="font-medium">{t('title')}</p>
      <p>{t('intro')}</p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          {t('step1')}
          <code className="mt-1 block select-all rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
            TIX_ALLOW_FOREIGN_BACKUP_KEYS=1
          </code>
        </li>
        <li>
          {t('step2')}
          <code className="mt-1 block select-all rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
            docker compose up -d
          </code>
        </li>
        <li>{t('step3')}</li>
      </ol>
      <p className="text-xs">{t('warning')}</p>
    </div>
  );
}

/** Compact summary the re-encryption job leaves in the status detail (JSON, language neutral). */
function ReEncryptSummary({ detail }: { detail: string }) {
  const t = useTranslations('backups.status.reencrypt');
  let parsed: {
    complete: boolean;
    removedKeys: number;
    undecryptable: number;
    remaining: number;
    tables: [string, number, number, number][];
  };
  try {
    parsed = JSON.parse(detail);
  } catch {
    return <p className="break-words text-xs text-warning">{detail}</p>;
  }
  const sum = (i: 1 | 2 | 3) => parsed.tables.reduce((n, row) => n + row[i], 0);
  return (
    <div className="space-y-1 text-xs">
      <p className={parsed.complete ? 'text-success' : 'text-destructive'}>
        {parsed.complete
          ? t('done', { reEncrypted: sum(1), skipped: sum(2), removed: parsed.removedKeys })
          : t('incomplete', { remaining: parsed.remaining, unreadable: parsed.undecryptable })}
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {parsed.tables.map(([table, reEncrypted, skipped, unreadable]) => (
          <li key={table}>{t('table', { table, reEncrypted, skipped, unreadable })}</li>
        ))}
      </ul>
    </div>
  );
}

/** Polls the progress of the running operation and refreshes the list when it finishes. */
export function BackupStatusPanel({ foreignKeysAllowed }: { foreignKeysAllowed: boolean }) {
  const tKey = useTranslations('backups.sourceKey');
  const t = useTranslations('backups.status');
  const router = useRouter();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const lastState = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/admin/backups/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as StatusResponse;
        if (stopped) return;
        setUnreachable(false);
        setData(next);
        const key = next.status ? `${next.status.startedAt}:${next.status.state}` : null;
        if (lastState.current !== null && key !== lastState.current) router.refresh();
        lastState.current = key;
      } catch {
        // During a restore the admin area itself can be unavailable for a moment.
        if (!stopped) setUnreachable(true);
      }
    };
    void poll();
    const timer = setInterval(poll, 3_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [router]);

  const status = data?.status;
  if (!status && !unreachable) return null;
  const stepLabel = (step: string) =>
    t.has(`steps.${step}` as 'steps.DONE') ? t(`steps.${step}` as 'steps.DONE') : step;
  const running = status?.state === 'RUNNING' && !status.stale;
  return (
    <div className="space-y-2 rounded-lg border p-4 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('title')}</span>
        {status && (
          <span className="text-muted-foreground">
            {t(`operation.${status.operation}`)} · {t(`state.${status.state}`)}
          </span>
        )}
      </div>
      {status && <p>{stepLabel(status.step)}</p>}
      {running && (
        <div className="h-1.5 overflow-hidden rounded bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded bg-primary" />
        </div>
      )}
      {status?.state === 'FAILED' && status.detail && status.operation !== 'REENCRYPT' && (
        <p className="break-words text-xs text-destructive">{status.detail}</p>
      )}
      {status?.state === 'FAILED' && OTHER_SYSTEM_STEPS.has(status.step) && (
        <div className="space-y-2">
          {foreignKeysAllowed ? (
            <Alert>
              <AlertDescription className="space-y-1">
                <p>{tKey('otherSystem')}</p>
                {status.operation === 'IMPORT' && <p>{tKey('otherSystemUpload')}</p>}
              </AlertDescription>
            </Alert>
          ) : (
            <ForeignKeysDisabledHint />
          )}
        </div>
      )}
      {status?.operation === 'REENCRYPT' && status.detail && status.state !== 'RUNNING' ? (
        <ReEncryptSummary detail={status.detail} />
      ) : (
        status?.state === 'SUCCEEDED' &&
        status.detail && <p className="break-words text-xs text-warning">{status.detail}</p>
      )}
      {status?.operation === 'REENCRYPT' && status.state === 'RUNNING' && status.detail && (
        <p className="text-xs text-muted-foreground">{status.detail}</p>
      )}
      {status?.stale && <p className="text-xs text-warning">{t('stale')}</p>}
      {(data?.maintenance || (unreachable && status?.operation === 'RESTORE')) && (
        <Alert>
          <AlertDescription>{t('restoreRunning')}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ─── Buttons ─────────────────────────────────────────────────────────────────────────

export function BackupNowButton({ action }: { action: OperationAction }) {
  const t = useTranslations('backups.actions');
  const feedback = useFeedback();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          feedback(await action());
          router.refresh();
        })
      }
    >
      <DatabaseBackup /> {t('backupNow')}
    </Button>
  );
}

export function ProbeNowButton({ action }: { action: OperationAction }) {
  const t = useTranslations('backups.actions');
  const feedback = useFeedback();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          feedback(await action());
          router.refresh();
        })
      }
    >
      <FlaskConical /> {t('probeNow')}
    </Button>
  );
}

/**
 * "⋯" menu of a backup row: download, verify and delete (the restore stays a visible button with
 * its own dialog). The delete confirmation lives outside the (non-modal) menu with controlled
 * state, so it stays mounted when the menu closes; it cannot be dismissed while deleting.
 */
export function BackupRowActions({
  id,
  label,
  verify,
  remove,
  hasExternalCopy,
}: {
  id: string;
  /** Accessible name of the menu trigger. */
  label: string;
  verify: OperationAction;
  remove: (deleteExternal: boolean) => Promise<BackupActionState>;
  hasExternalCopy: boolean;
}) {
  const t = useTranslations('backups');
  const feedback = useFeedback();
  const router = useRouter();
  const [verifying, startVerify] = useTransition();
  const [open, setOpen] = useState(false);
  const [deleteExternal, setDeleteExternal] = useState(false);
  const [pending, start] = useTransition();
  // Set when the menu closes because the dialog opens: the focus then goes to the dialog.
  const openingDialog = useRef(false);
  const trigger = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={trigger} className="inline-flex">
        <RowActions
          label={label}
          data-testid="backup-row-actions"
          onCloseAutoFocus={(e) => {
            if (openingDialog.current) e.preventDefault();
            openingDialog.current = false;
          }}
        >
          <DropdownMenuItem asChild>
            <a href={`/api/admin/backups/${id}/download`}>
              <Download /> {t('actions.download')}
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={verifying}
            onSelect={() => startVerify(async () => feedback(await verify()))}
          >
            <ShieldCheck /> {t('actions.verify')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              openingDialog.current = true;
              setOpen(true);
            }}
          >
            <Trash2 /> {t('actions.delete')}
          </DropdownMenuItem>
        </RowActions>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && pending) return;
          setOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={!pending}
          onEscapeKeyDown={(e) => {
            if (pending) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (pending) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            // The menu item is gone: the focus returns to the row's menu button.
            e.preventDefault();
            trigger.current?.querySelector<HTMLElement>('button')?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('deleteConfirm.title')}</DialogTitle>
            <DialogDescription>{t('deleteConfirm.description')}</DialogDescription>
          </DialogHeader>
          {hasExternalCopy && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={deleteExternal}
                onChange={(e) => setDeleteExternal(e.target.checked)}
              />
              <span>{t('deleteConfirm.external')}</span>
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              data-testid="backup-delete-confirm"
              onClick={() =>
                start(async () => {
                  feedback(await remove(deleteExternal));
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {t('actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Upload ──────────────────────────────────────────────────────────────────────────

export function UploadBackupButton({ foreignKeysAllowed }: { foreignKeysAllowed: boolean }) {
  const t = useTranslations('backups');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);

  const send = (file: File, keyToken: string | null) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/backups/upload');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    // Only an opaque single-use token travels with the upload, never the key itself.
    if (keyToken) xhr.setRequestHeader('x-tix-key-token', keyToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPercent(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setPercent(null);
      if (xhr.status === 202) {
        toast.success(t('upload.accepted'));
        setOpen(false);
        router.refresh();
      } else {
        let code = '';
        try {
          code = (JSON.parse(xhr.responseText) as { error?: { code?: string } }).error?.code ?? '';
        } catch {
          /* not JSON */
        }
        toast.error(code === 'NOT_A_BACKUP' ? t('upload.notABackup') : t('upload.failed'));
      }
    };
    xhr.onerror = () => {
      setPercent(null);
      toast.error(t('upload.failed'));
    };
    setPercent(0);
    xhr.send(file);
  };

  const start = async (file: File) => {
    const text = foreignKeysAllowed ? (keys.current?.value ?? '') : '';
    let token: string | null = null;
    if (text.trim() !== '') {
      const staged = await stageUploadKeysAction(text);
      if (!staged.ok) {
        toast.error(
          staged.error === 'rateLimited'
            ? t('feedback.rateLimited')
            : staged.error === 'disabled'
              ? t('sourceKey.disabled.short')
              : t('upload.dialog.keyFailed'),
        );
        return;
      }
      token = staged.token;
    }
    send(file, token);
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload /> {percent === null ? t('actions.upload') : t('actions.uploading', { percent })}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('upload.dialog.title')}</DialogTitle>
            <DialogDescription>{t('upload.dialog.description')}</DialogDescription>
          </DialogHeader>
          {foreignKeysAllowed ? (
            <>
              <p className="text-xs text-muted-foreground">{t('upload.dialog.keyHint')}</p>
              <Field label={t('sourceKey.label')} htmlFor="upload-source-keys">
                <Textarea
                  id="upload-source-keys"
                  ref={keys}
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className="font-mono text-xs"
                />
              </Field>
            </>
          ) : (
            <ForeignKeysDisabledHint />
          )}
          <input
            ref={input}
            type="file"
            accept=".tixbak"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void start(file);
              e.target.value = '';
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button disabled={percent !== null} onClick={() => input.current?.click()}>
              <Upload />{' '}
              {percent === null ? t('upload.dialog.choose') : t('actions.uploading', { percent })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Restore ─────────────────────────────────────────────────────────────────────────

export function RestoreButton({
  backupId,
  createdAtLabel,
  preview,
  restore,
  label,
  databaseOnly = false,
}: {
  label?: string;
  /** Database-only backup (before an update): the files are not touched. */
  databaseOnly?: boolean;
  backupId: string;
  createdAtLabel: string;
  preview: (id: string) => Promise<RestorePreview | null>;
  restore: (id: string, state: BackupActionState, fd: FormData) => Promise<BackupActionState>;
}) {
  const t = useTranslations('backups');
  const feedback = useFeedback();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RestorePreview | null>(null);
  const [loading, startLoading] = useTransition();
  const [state, formAction] = useActionState(restore.bind(null, backupId), BACKUP_IDLE);
  // Keys of another system: optional; the check only reads the first block of the archive.
  const sourceKeys = useRef<HTMLTextAreaElement>(null);
  const [keyCheck, setKeyCheck] = useState<SourceKeyCheck | null>(null);
  const [checking, startChecking] = useTransition();

  useEffect(() => {
    if (state.status === 'idle') return;
    feedback(state);
    if (state.status === 'success') {
      setOpen(false);
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const lossTotal = data
    ? data.loss.orders + data.loss.invoices + data.loss.payments + data.loss.refunds
    : 0;

  // Passkey confirmation: fresh assertion for this backup, sent with the form (password and
  // acknowledgement are still required).
  const [webauthn, setWebauthn] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passkeyChallenge = useRef<HTMLInputElement>(null);
  const passkeyResponse = useRef<HTMLInputElement>(null);
  useEffect(() => setWebauthn(browserSupportsWebAuthn()), []);
  const canPasskey = Boolean(data?.passkeys) && webauthn;

  const confirmWithPasskey = async (form: HTMLFormElement | null) => {
    if (!form || !form.reportValidity()) return;
    setPasskeyBusy(true);
    try {
      const prepared = await restorePasskeyOptionsAction(backupId);
      if (!prepared.ok) {
        toast.error(
          t(prepared.error === 'rateLimited' ? 'feedback.rateLimited' : 'feedback.passkeyInvalid'),
        );
        return;
      }
      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: prepared.options });
      } catch (err) {
        const cancelled =
          err instanceof Error &&
          (err.name === 'NotAllowedError' ||
            err.name === 'AbortError' ||
            err.name === 'ERROR_CEREMONY_ABORTED');
        if (!cancelled) toast.error(t('feedback.passkeyInvalid'));
        return;
      }
      if (!passkeyChallenge.current || !passkeyResponse.current) return;
      passkeyChallenge.current.value = prepared.challengeId;
      passkeyResponse.current.value = JSON.stringify(assertion);
      form.requestSubmit();
      // The assertion is single use: never send it along with a later code submission.
      passkeyChallenge.current.value = '';
      passkeyResponse.current.value = '';
    } finally {
      setPasskeyBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          setData(null);
          startLoading(async () => setData(await preview(backupId)));
        }}
      >
        <RotateCcw /> {label ?? t('actions.restore')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('restore.title')}</DialogTitle>
            <DialogDescription>
              {t(databaseOnly ? 'restore.descriptionDatabaseOnly' : 'restore.description', {
                date: createdAtLabel,
              })}
            </DialogDescription>
          </DialogHeader>
          {loading || !data ? (
            <p className="text-sm text-muted-foreground">{t('restore.loading')}</p>
          ) : data.twoFactorSetupRequired ? (
            <div className="space-y-3 text-sm">
              <p>{t('restore.twoFactorSetup')}</p>
              <Button asChild variant="outline" size="sm">
                <a href="/admin/account">{t('restore.twoFactorSetupLink')}</a>
              </Button>
            </div>
          ) : (
            <ActionForm action={formAction} className="space-y-4" autoComplete="off">
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                {lossTotal > 0 ? (
                  <>
                    <p className="font-medium">{t('restore.lossTitle')}</p>
                    <p>{t('restore.loss', data.loss)}</p>
                  </>
                ) : (
                  <p>{t('restore.lossNone')}</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">{t('restore.gobd')}</p>
              </div>
              {data.needsSourceKey && (
                <Alert>
                  <AlertDescription>{t('sourceKey.otherSystem')}</AlertDescription>
                </Alert>
              )}
              {data.secretKeysMissing.length > 0 && (
                <Alert className="border-warning-border bg-warning-soft text-warning">
                  <AlertDescription>
                    {t('restore.secretKeysMissing', { keys: data.secretKeysMissing.join(', ') })}
                  </AlertDescription>
                </Alert>
              )}
              {data.foreignKeysAllowed ? (
                <details className="rounded-md border p-3 text-sm" open={data.needsSourceKey}>
                  <summary className="cursor-pointer font-medium">{t('sourceKey.summary')}</summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">{t('sourceKey.hint')}</p>
                    <Field label={t('sourceKey.label')} htmlFor="restore-source-keys">
                      <Textarea
                        id="restore-source-keys"
                        name="sourceKeys"
                        ref={sourceKeys}
                        rows={3}
                        spellCheck={false}
                        autoComplete="off"
                        autoCapitalize="off"
                        className="font-mono text-xs"
                        onChange={() => setKeyCheck(null)}
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={checking}
                        onClick={() =>
                          startChecking(async () =>
                            setKeyCheck(
                              await checkSourceKeysAction(
                                backupId,
                                sourceKeys.current?.value ?? '',
                              ),
                            ),
                          )
                        }
                      >
                        {checking ? t('sourceKey.checking') : t('sourceKey.check')}
                      </Button>
                      {keyCheck && (
                        <span
                          role="status"
                          className={
                            keyCheck.result === 'match' || keyCheck.result === 'readable'
                              ? 'text-xs text-success'
                              : 'text-xs text-destructive'
                          }
                        >
                          {t(`sourceKey.results.${keyCheck.result}`)}
                        </span>
                      )}
                    </div>
                    {keyCheck && 'stillMissing' in keyCheck && keyCheck.stillMissing ? (
                      <p role="status" className="text-xs text-warning">
                        {t('sourceKey.stillMissing', { count: keyCheck.stillMissing })}
                      </p>
                    ) : null}
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="reencrypt" defaultChecked className="mt-1" />
                      <span>
                        {t('sourceKey.reencrypt.label')}
                        <span className="block text-xs text-muted-foreground">
                          {t('sourceKey.reencrypt.hint')}
                        </span>
                      </span>
                    </label>
                  </div>
                </details>
              ) : data.needsSourceKey ? (
                <ForeignKeysDisabledHint />
              ) : null}
              <Field label={t('restore.password')} htmlFor="restore-password">
                <Input
                  id="restore-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              {data.twoFactor && (
                <Field label={t('restore.code')} htmlFor="restore-code">
                  <Input
                    id="restore-code"
                    name="code"
                    inputMode="text"
                    autoComplete="one-time-code"
                    required={!canPasskey}
                  />
                </Field>
              )}
              {canPasskey && (
                <>
                  <input type="hidden" name="passkeyChallengeId" ref={passkeyChallenge} />
                  <input type="hidden" name="passkeyResponse" ref={passkeyResponse} />
                  <p className="text-xs text-muted-foreground">{t('restore.passkeyHint')}</p>
                </>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="acknowledge" className="mt-1" required />
                <span>{t('restore.acknowledge')}</span>
              </label>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  {t('actions.cancel')}
                </Button>
                {canPasskey && (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={passkeyBusy}
                    onClick={(e) => void confirmWithPasskey(e.currentTarget.form)}
                  >
                    {passkeyBusy ? t('restore.passkeyWaiting') : t('restore.passkeySubmit')}
                  </Button>
                )}
                <SubmitButton
                  variant={canPasskey ? 'outline' : 'destructive'}
                  pendingLabel={t('restore.submitting')}
                  // Unreadable without the other system's key, and entering it is switched off.
                  disabled={(data.needsSourceKey && !data.foreignKeysAllowed) || undefined}
                >
                  {t('restore.submit')}
                </SubmitButton>
              </DialogFooter>
            </ActionForm>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Small "dismiss" button for a persistent notice. */
export function DismissNoticeButton({
  action,
  label,
}: {
  action: () => Promise<BackupActionState>;
  label: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await action();
          router.refresh();
        })
      }
    >
      {label}
    </Button>
  );
}

// ─── Re-encrypt secrets ──────────────────────────────────────────────────────────────

/** Standalone "Re-encrypt now": password + second factor, then a worker job (progress in the panel). */
export function ReEncryptButton({
  action,
  twoFactor,
  passkeys,
  backupsUsingKeys,
  backupsUnchecked,
}: {
  action: (state: BackupActionState, fd: FormData) => Promise<BackupActionState>;
  twoFactor: boolean;
  passkeys: boolean;
  /** Catalogued backups whose manifests reference the additional keys about to be removed. */
  backupsUsingKeys: number;
  /** Catalogued backups without key information (made by older versions): cannot be checked. */
  backupsUnchecked: number;
}) {
  const t = useTranslations('backups');
  const feedback = useFeedback();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, BACKUP_IDLE);
  const [webauthn, setWebauthn] = useState(false);
  const [busy, setBusy] = useState(false);
  const challenge = useRef<HTMLInputElement>(null);
  const response = useRef<HTMLInputElement>(null);
  useEffect(() => setWebauthn(browserSupportsWebAuthn()), []);
  const canPasskey = passkeys && webauthn;

  useEffect(() => {
    if (state.status === 'idle') return;
    feedback(state);
    if (state.status === 'success') {
      setOpen(false);
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const confirmWithPasskey = async (form: HTMLFormElement | null) => {
    if (!form || !form.reportValidity()) return;
    setBusy(true);
    try {
      const prepared = await reEncryptPasskeyOptionsAction();
      if (!prepared.ok) {
        toast.error(
          t(prepared.error === 'rateLimited' ? 'feedback.rateLimited' : 'feedback.passkeyInvalid'),
        );
        return;
      }
      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: prepared.options });
      } catch (err) {
        const cancelled =
          err instanceof Error &&
          (err.name === 'NotAllowedError' ||
            err.name === 'AbortError' ||
            err.name === 'ERROR_CEREMONY_ABORTED');
        if (!cancelled) toast.error(t('feedback.passkeyInvalid'));
        return;
      }
      if (!challenge.current || !response.current) return;
      challenge.current.value = prepared.challengeId;
      response.current.value = JSON.stringify(assertion);
      form.requestSubmit();
      // The assertion is single use: never send it along with a later code submission.
      challenge.current.value = '';
      response.current.value = '';
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <KeyRound /> {t('reencrypt.button')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('reencrypt.title')}</DialogTitle>
            <DialogDescription>{t('reencrypt.description')}</DialogDescription>
          </DialogHeader>
          <ActionForm action={formAction} className="space-y-4" autoComplete="off">
            <p className="text-xs text-muted-foreground">{t('reencrypt.backupsNote')}</p>
            <p
              className={
                backupsUsingKeys > 0
                  ? 'text-sm font-medium text-warning'
                  : 'text-xs text-muted-foreground'
              }
            >
              {t('reencrypt.keysUsedByBackups', { count: backupsUsingKeys })}
            </p>
            {backupsUnchecked > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('reencrypt.backupsUnchecked', { count: backupsUnchecked })}
              </p>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acknowledge" className="mt-1" required />
              <span>{t('reencrypt.acknowledge')}</span>
            </label>
            <Field label={t('reencrypt.password')} htmlFor="reencrypt-password">
              <Input
                id="reencrypt-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            {twoFactor && (
              <Field label={t('reencrypt.code')} htmlFor="reencrypt-code">
                <Input
                  id="reencrypt-code"
                  name="code"
                  inputMode="text"
                  autoComplete="one-time-code"
                  required={!canPasskey}
                />
              </Field>
            )}
            {canPasskey && (
              <>
                <input type="hidden" name="passkeyChallengeId" ref={challenge} />
                <input type="hidden" name="passkeyResponse" ref={response} />
                <p className="text-xs text-muted-foreground">{t('reencrypt.passkeyHint')}</p>
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('actions.cancel')}
              </Button>
              {canPasskey && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={(e) => void confirmWithPasskey(e.currentTarget.form)}
                >
                  {t('reencrypt.passkeySubmit')}
                </Button>
              )}
              <SubmitButton
                variant={canPasskey ? 'outline' : 'default'}
                pendingLabel={t('reencrypt.submitting')}
              >
                {t('reencrypt.submit')}
              </SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
