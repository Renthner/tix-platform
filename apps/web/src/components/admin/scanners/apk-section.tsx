'use client';

import { Check, Copy, Download, Loader2, Trash2, Upload } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { Field } from '../form-controls';
import { adminRequest, useErrorMessage } from './scanner-client';

export interface ApkReleaseRow {
  id: string;
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  isCurrent: boolean;
  createdAt: string;
}

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function LinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations('scanners.apk');
  const message = useErrorMessage();
  const format = useFormatter();
  const [link, setLink] = useState<{
    url: string;
    qrDataUrl: string;
    expiresAt: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(false);

  // The dialog is mounted already open, so Radix never reports an "open" change: request the
  // signed link whenever the dialog becomes visible.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setLink(null);
    setCopied(false);
    setLoading(true);
    void adminRequest<{ url: string; qrDataUrl: string; expiresAt: string | null }>(
      '/api/admin/scanners/apk/link',
      { method: 'POST' },
    ).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) setLink(result.data);
      else setError(message(result.code));
    });
    return () => {
      cancelled = true;
    };
    // `message` is a fresh function per render; the request must run once per opening only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const load = (next: boolean) => onOpenChange(next);

  return (
    <Dialog open={open} onOpenChange={load}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('linkTitle')}</DialogTitle>
          <DialogDescription>
            {link
              ? link.expiresAt
                ? t('linkText', {
                    time: format.dateTime(new Date(link.expiresAt), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }),
                  })
                : t('linkTextGithub')
              : ''}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('linkLoading')}
          </div>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {link ? (
          <div className="space-y-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
            <img
              src={link.qrDataUrl}
              alt=""
              width={240}
              height={240}
              className="mx-auto size-60 rounded-md border"
            />
            <Input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(link.url).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? t('copied') : t('copy')}
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => load(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadForm() {
  const t = useTranslations('scanners.apk.upload');
  const router = useRouter();
  const message = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [makeCurrent, setMakeCurrent] = useState(true);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    data.set('makeCurrent', makeCurrent ? 'true' : 'false');
    setBusy(true);
    setError(null);
    setDone(false);
    const result = await adminRequest('/api/admin/scanners/apk', { method: 'POST', form: data });
    setBusy(false);
    if (!result.ok) {
      setError(message(result.code));
      return;
    }
    form.reset();
    setDone(true);
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {done ? (
        <Alert>
          <AlertDescription>{t('done')}</AlertDescription>
        </Alert>
      ) : null}
      <Field label={t('file')} htmlFor="apkFile">
        <Input
          id="apkFile"
          name="file"
          type="file"
          required
          accept=".apk,application/vnd.android.package-archive"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('versionName')} htmlFor="apkVersionName" hint={t('versionNameHint')}>
          <Input id="apkVersionName" name="versionName" required maxLength={40} />
        </Field>
        <Field label={t('versionCode')} htmlFor="apkVersionCode" hint={t('versionCodeHint')}>
          <Input
            id="apkVersionCode"
            name="versionCode"
            type="number"
            inputMode="numeric"
            min={1}
            required
          />
        </Field>
      </div>
      <Field label={t('notes')} htmlFor="apkNotes">
        <Textarea id="apkNotes" name="notes" maxLength={2000} rows={2} />
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id="apkMakeCurrent"
          checked={makeCurrent}
          onCheckedChange={(c) => setMakeCurrent(c === true)}
        />
        <Label htmlFor="apkMakeCurrent" className="cursor-pointer font-normal">
          {t('makeCurrent')}
        </Label>
      </div>
      <Button type="submit" disabled={busy}>
        <Upload /> {busy ? t('uploading') : t('submit')}
      </Button>
    </form>
  );
}

function ReleaseActions({ release }: { release: ApkReleaseRow }) {
  const t = useTranslations('scanners.apk');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const message = useErrorMessage();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (method: 'PATCH' | 'DELETE') => {
    setError(null);
    const result = await adminRequest(`/api/admin/scanners/apk/${release.id}`, {
      method,
      json: method === 'PATCH' ? { current: true } : undefined,
    });
    if (!result.ok) {
      setError(message(result.code));
      return;
    }
    setConfirming(false);
    router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {!release.isCurrent ? (
        <>
          <Button type="button" size="sm" variant="outline" onClick={() => run('PATCH')}>
            {t('makeCurrent')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            <Trash2 /> {t('delete')}
          </Button>
        </>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>{t('deleteText', { name: release.versionName })}</DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              {tc('cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => run('DELETE')}>
              {t('deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Scanner app releases: download link + QR for everyone with scanner access, upload for super admins. */
export function ApkSection({
  releases,
  canUpload,
  source,
  githubRepository,
  serverVersion,
  canEditSettings,
}: {
  releases: ApkReleaseRow[];
  canUpload: boolean;
  source: 'GITHUB' | 'SERVER';
  githubRepository: string;
  serverVersion: string;
  canEditSettings: boolean;
}) {
  const t = useTranslations('scanners.apk');
  const format = useFormatter();
  const [linkOpen, setLinkOpen] = useState(false);
  const current = releases.find((r) => r.isCurrent) ?? null;
  // GitHub without a repository on the server: the app may still use its built-in one, but staff links need an upload.
  const github = source === 'GITHUB' && githubRepository !== '';
  const githubUnset = source === 'GITHUB' && githubRepository === '';

  return (
    <div className="space-y-5 p-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      {githubUnset ? (
        <Alert>
          <AlertDescription>
            {t('github.noRepository')}{' '}
            {canEditSettings ? (
              <Link href="/admin/settings/scanner" className="underline">
                {t('github.settings')}
              </Link>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {github ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-muted/40 p-4">
          <div className="space-y-1 text-sm">
            <div className="font-medium">{t('github.title', { repository: githubRepository })}</div>
            <div className="text-muted-foreground">
              {t('github.text', { version: serverVersion })}
            </div>
            {canEditSettings ? (
              <Link href="/admin/settings/scanner" className="text-xs underline">
                {t('github.settings')}
              </Link>
            ) : null}
          </div>
          <Button type="button" onClick={() => setLinkOpen(true)}>
            <Download /> {t('getLink')}
          </Button>
          {linkOpen ? <LinkDialog open onOpenChange={setLinkOpen} /> : null}
        </div>
      ) : null}
      {github ? <p className="text-sm text-muted-foreground">{t('github.uploadsHint')}</p> : null}
      {current && !github ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-4">
          <div className="space-y-1 text-sm">
            <div className="font-medium">
              {t('current')}:{' '}
              {t('version', { name: current.versionName, code: current.versionCode })}
            </div>
            <div className="text-muted-foreground">
              {t('size')}: {formatSize(current.sizeBytes)} · {t('uploaded')}:{' '}
              {format.dateTime(new Date(current.createdAt), { dateStyle: 'medium' })}
            </div>
            <div className="break-all font-mono text-xs text-muted-foreground">
              {t('sha')}: {current.sha256}
            </div>
            {current.notes ? <div className="whitespace-pre-line">{current.notes}</div> : null}
          </div>
          <Button type="button" onClick={() => setLinkOpen(true)}>
            <Download /> {t('getLink')}
          </Button>
          {linkOpen ? <LinkDialog open onOpenChange={setLinkOpen} /> : null}
        </div>
      ) : github ? null : (
        <p className="text-sm">{t('none')}</p>
      )}
      {releases.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t('releases')}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('current')}</TableHead>
                <TableHead>{t('size')}</TableHead>
                <TableHead>{t('uploaded')}</TableHead>
                {canUpload ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.map((release) => (
                <TableRow key={release.id}>
                  <TableCell>
                    {t('version', { name: release.versionName, code: release.versionCode })}{' '}
                    {release.isCurrent ? <Badge>{t('currentBadge')}</Badge> : null}
                  </TableCell>
                  <TableCell>{formatSize(release.sizeBytes)}</TableCell>
                  <TableCell>
                    {format.dateTime(new Date(release.createdAt), { dateStyle: 'medium' })}
                  </TableCell>
                  {canUpload ? (
                    <TableCell>
                      <ReleaseActions release={release} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {canUpload ? <UploadForm /> : null}
    </div>
  );
}
