'use client';

import { DatabaseBackup, Download, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { BACKUP_IDLE, type BackupActionState, type RestorePreview } from '@/lib/backup-state';
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
    operation: 'BACKUP' | 'VERIFY' | 'RESTORE' | 'IMPORT';
    state: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    step: string;
    startedAt: string;
    updatedAt: string;
    detail?: string;
    stale: boolean;
  } | null;
  maintenance: boolean;
}

/** Polls the progress of the running operation and refreshes the list when it finishes. */
export function BackupStatusPanel() {
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
      {status?.state === 'FAILED' && status.detail && (
        <p className="break-words text-xs text-destructive">{status.detail}</p>
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

export function VerifyButton({ action }: { action: OperationAction }) {
  const t = useTranslations('backups.actions');
  const feedback = useFeedback();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => start(async () => feedback(await action()))}
    >
      <ShieldCheck /> {t('verify')}
    </Button>
  );
}

export function DeleteBackupButton({
  action,
  hasExternalCopy,
}: {
  action: (deleteExternal: boolean) => Promise<BackupActionState>;
  hasExternalCopy: boolean;
}) {
  const t = useTranslations('backups');
  const feedback = useFeedback();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleteExternal, setDeleteExternal] = useState(false);
  const [pending, start] = useTransition();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2 /> {t('actions.delete')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
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
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  feedback(await action(deleteExternal));
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

export function DownloadLink({ id }: { id: string }) {
  const t = useTranslations('backups.actions');
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={`/api/admin/backups/${id}/download`}>
        <Download /> {t('download')}
      </a>
    </Button>
  );
}

// ─── Upload ──────────────────────────────────────────────────────────────────────────

export function UploadBackupButton() {
  const t = useTranslations('backups');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [percent, setPercent] = useState<number | null>(null);

  const send = (file: File) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/backups/upload');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setPercent(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setPercent(null);
      if (xhr.status === 202) {
        toast.success(t('upload.accepted'));
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

  return (
    <div className="space-y-1">
      <input
        ref={input}
        type="file"
        accept=".tixbak"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) send(file);
          e.target.value = '';
        }}
      />
      <Button variant="outline" disabled={percent !== null} onClick={() => input.current?.click()}>
        <Upload /> {percent === null ? t('actions.upload') : t('actions.uploading', { percent })}
      </Button>
    </div>
  );
}

// ─── Restore ─────────────────────────────────────────────────────────────────────────

export function RestoreButton({
  backupId,
  createdAtLabel,
  preview,
  restore,
  label,
}: {
  label?: string;
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('restore.title')}</DialogTitle>
            <DialogDescription>
              {t('restore.description', { date: createdAtLabel })}
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
                    required
                  />
                </Field>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="acknowledge" className="mt-1" required />
                <span>{t('restore.acknowledge')}</span>
              </label>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  {t('actions.cancel')}
                </Button>
                <SubmitButton variant="destructive" pendingLabel={t('restore.submitting')}>
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
