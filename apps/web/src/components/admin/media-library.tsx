'use client';

import type { MediaUsageType } from '@tix/core';
import type { MediaAssetKind } from '@tix/shared';
import { Download, ExternalLink, Trash2, Upload } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { formatBytes } from '@/lib/bytes';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ConfirmAction } from './confirm-action';
import {
  ActionFeedback,
  ActionForm,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export interface MediaUsageView {
  type: MediaUsageType;
  label: string;
  detail: string | null;
  href: string | null;
}

export interface MediaCard {
  id: string;
  kind: MediaAssetKind;
  fileName: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  uploadedByName: string | null;
  usages: MediaUsageView[];
  rename: Action;
  remove: Action;
}

export function MediaGrid({ items }: { items: MediaCard[] }) {
  const t = useTranslations('admin.mediaLibrary');
  const format = useFormatter();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {items.map((m) => {
        const used = m.usages.length > 0;
        return (
          <li key={m.id} className="flex flex-col rounded-xl border bg-card">
            <a
              href={`/api/media/${m.id}`}
              target="_blank"
              rel="noreferrer"
              className="flex h-40 items-center justify-center overflow-hidden rounded-t-xl bg-muted/40"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/media/${m.id}`}
                alt={m.fileName}
                loading="lazy"
                className="max-h-full max-w-full object-contain"
              />
            </a>
            <div className="flex flex-1 flex-col gap-2 p-3 text-sm">
              <span className="font-medium break-all">{m.fileName}</span>
              <div className="flex flex-wrap gap-1 text-xs">
                <Badge variant="outline">{t(`kinds.${m.kind}`)}</Badge>
                <Badge variant={used ? 'secondary' : 'outline'}>
                  {used ? t('usedCount', { count: m.usages.length }) : t('unused')}
                </Badge>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <dt>{t('dimensions')}</dt>
                <dd>{m.width && m.height ? `${m.width} × ${m.height} px` : '–'}</dd>
                <dt>{t('size')}</dt>
                <dd>{formatBytes(m.sizeBytes)}</dd>
                <dt>{t('uploaded')}</dt>
                <dd>
                  {format.dateTime(new Date(m.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                  {m.uploadedByName ? ` · ${m.uploadedByName}` : ''}
                </dd>
                <dt>SHA-256</dt>
                <dd className="font-mono" title={m.sha256}>
                  {m.sha256.slice(0, 12)}…
                </dd>
              </dl>
              {used && (
                <div className="text-xs">
                  <p className="font-medium">{t('usedBy')}</p>
                  <ul className="mt-1 space-y-0.5">
                    {m.usages.map((u, i) => (
                      <li key={`${u.type}-${u.label}-${u.detail}-${i}`}>
                        <span className="text-muted-foreground">{t(`usage.${u.type}`)}: </span>
                        {u.href ? (
                          <Link href={u.href} className="underline underline-offset-2">
                            {u.label}
                          </Link>
                        ) : (
                          u.label
                        )}
                        {u.detail && ['WALLET_DESIGN', 'EMAIL_TEMPLATE', 'OTHER'].includes(u.type)
                          ? ` (${u.detail})`
                          : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                <RenameDialog name={m.fileName} action={m.rename} />
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/media/${m.id}`} target="_blank" rel="noreferrer">
                    <ExternalLink /> {t('open')}
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/media/${m.id}?download=1`}>
                    <Download /> {t('download')}
                  </a>
                </Button>
                <ConfirmAction
                  action={m.remove}
                  disabled={used}
                  label={used ? t('deleteBlocked') : undefined}
                  title={t('deleteTitle')}
                  description={t('deleteDescription', { name: m.fileName })}
                  confirmLabel={t('delete')}
                >
                  <Trash2 /> {t('delete')}
                </ConfirmAction>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RenameDialog({ name, action }: { name: string; action: Action }) {
  const t = useTranslations('admin.mediaLibrary');
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          {t('rename')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('rename')}</DialogTitle>
          <DialogDescription>{t('renameHint')}</DialogDescription>
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <Field label={t('name')} htmlFor="media-rename" error={errorOf(state, 'name')}>
            <Input id="media-rename" name="name" defaultValue={name} required maxLength={150} />
          </Field>
          <DialogFooter>
            <SubmitButton>{tc('save')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** Uploads through `POST /api/admin/media` (images exceed the server-action body limit). */
export function MediaUploadForm({
  kinds,
  defaultKind,
}: {
  kinds: readonly MediaAssetKind[];
  defaultKind: MediaAssetKind;
}) {
  const t = useTranslations('admin.mediaLibrary');
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState(0);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const kind = new FormData(event.currentTarget).get('kind');
    const files = Array.from(fileInput.current?.files ?? []);
    if (files.length === 0 || typeof kind !== 'string') return;
    setBusy(true);
    setErrors([]);
    setDone(0);
    const failed: string[] = [];
    let ok = 0;
    for (const file of files) {
      const body = new FormData();
      body.set('kind', kind);
      body.set('file', file);
      try {
        const res = await fetch('/api/admin/media', { method: 'POST', body });
        if (res.ok) ok += 1;
        else {
          const json = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          failed.push(`${file.name}: ${json?.error?.message ?? res.status}`);
        }
      } catch {
        failed.push(`${file.name}: ${t('uploadNetworkError')}`);
      }
    }
    setBusy(false);
    setErrors(failed);
    setDone(ok);
    if (fileInput.current) fileInput.current.value = '';
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {done > 0 && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {t('uploadedCount', { count: done })}
        </p>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('kind')} htmlFor="media-kind">
          <NativeSelect id="media-kind" name="kind" defaultValue={defaultKind}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`kinds.${k}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('file')} htmlFor="media-file" hint={t('fileHint')}>
          <Input
            id="media-file"
            ref={fileInput}
            type="file"
            multiple
            required
            accept="image/png,image/jpeg,image/webp"
          />
        </Field>
      </div>
      <Button type="submit" disabled={busy}>
        <Upload /> {busy ? t('uploading') : t('upload')}
      </Button>
    </form>
  );
}

export interface BulkItem {
  id: string;
  fileName: string;
  kind: MediaAssetKind;
  sizeBytes: number;
}

/** Preview + confirmation for "delete all unused" (acts on exactly the listed assets). */
export function BulkDeleteDialog({
  items,
  total,
  action,
}: {
  items: BulkItem[];
  total: number;
  action: Action;
}) {
  const t = useTranslations('admin.mediaLibrary');
  const tc = useTranslations('common.actions');
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(action, IDLE);
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);
  const bytes = items.reduce((s, i) => s + i.sizeBytes, 0);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={items.length === 0}>
          <Trash2 /> {t('bulkDelete')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('bulkTitle')}</DialogTitle>
          <DialogDescription>
            {t('bulkDescription', { count: items.length, size: formatBytes(bytes) })}
            {total > items.length ? ` ${t('bulkCapped', { total })}` : ''}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex justify-between gap-2">
              <span className="break-all">
                {i.fileName} <span className="text-muted-foreground">({t(`kinds.${i.kind}`)})</span>
              </span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(i.sizeBytes)}</span>
            </li>
          ))}
        </ul>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </Button>
            <SubmitButton variant="destructive">{t('bulkConfirm')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function SweepOrphansButton({ action }: { action: Action }) {
  const t = useTranslations('admin.mediaLibrary');
  return (
    <ConfirmAction
      action={action}
      variant="outline"
      size="default"
      title={t('sweepTitle')}
      description={t('sweepDescription')}
      confirmLabel={t('sweepConfirm')}
    >
      {t('sweep')}
    </ConfirmAction>
  );
}
