'use client';

import { SYMBOL_KINDS, type SymbolKind } from '@tix/shared';
import { Lock, Trash2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ConfirmAction } from './confirm-action';
import {
  ActionForm,
  ActionFeedback,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

export interface SymbolCard {
  id: string;
  name: string;
  kind: SymbolKind;
  viewBox: string;
  /** Server-side sanitised SVG body (shape elements only). */
  markup: string;
  colorize: boolean;
  builtin: boolean;
  usage: number;
  rename: Action;
  remove: Action | null;
}

export function SymbolPreview({
  viewBox,
  markup,
  className,
}: {
  viewBox: string;
  markup: string;
  className?: string;
}) {
  return (
    <svg
      viewBox={viewBox}
      fill="currentColor"
      className={className}
      aria-hidden
      // Markup is sanitised by the server (sanitizeSvg) before it is stored.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export function SymbolGrid({ symbols }: { symbols: SymbolCard[] }) {
  const t = useTranslations('admin.symbols');
  if (symbols.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  return (
    <ul className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      {symbols.map((s) => (
        <li key={s.id} className="flex flex-col rounded-xl border bg-card">
          <div className="flex h-28 items-center justify-center rounded-t-xl bg-muted/40 text-primary">
            <SymbolPreview viewBox={s.viewBox} markup={s.markup} className="size-16" />
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium break-words">{s.name}</span>
              {s.builtin && (
                <Badge variant="secondary" className="shrink-0">
                  <Lock /> {t('builtin')}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-1 text-xs">
              <Badge variant="outline">{t(`kinds.${s.kind}`)}</Badge>
              {s.colorize && <Badge variant="outline">{t('colorized')}</Badge>}
              <Badge variant="outline">{t('usage', { count: s.usage })}</Badge>
            </div>
            <div className="mt-auto flex flex-wrap gap-2 pt-1">
              <RenameDialog name={s.name} action={s.rename} />
              {s.remove && (
                <ConfirmAction
                  action={s.remove}
                  title={t('deleteTitle')}
                  description={
                    s.usage > 0
                      ? t('deleteUsed', { name: s.name, count: s.usage })
                      : t('deleteUnused', { name: s.name })
                  }
                  confirmLabel={t('delete')}
                >
                  <Trash2 /> {t('delete')}
                </ConfirmAction>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RenameDialog({ name, action }: { name: string; action: Action }) {
  const t = useTranslations('admin.symbols');
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
        </DialogHeader>
        <ActionForm action={formAction} className="space-y-4">
          <ActionFeedback state={state} />
          <Field label={t('name')} htmlFor="symbol-rename" error={errorOf(state, 'name')}>
            <Input id="symbol-rename" name="name" defaultValue={name} required maxLength={120} />
          </Field>
          <DialogFooter>
            <SubmitButton>{tc('save')}</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function SymbolUploadForm({
  action,
  defaultKind,
}: {
  action: Action;
  defaultKind: SymbolKind;
}) {
  const t = useTranslations('admin.symbols');
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <ActionForm action={formAction} resetOnSuccess={state} className="space-y-4">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={t('name')} htmlFor="symbol-name" error={errorOf(state, 'name')}>
          <Input id="symbol-name" name="name" required maxLength={120} />
        </Field>
        <Field label={t('kind')} htmlFor="symbol-kind" error={errorOf(state, 'kind')}>
          <NativeSelect id="symbol-kind" name="kind" defaultValue={defaultKind}>
            {SYMBOL_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kinds.${k}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label={t('file')}
          htmlFor="symbol-file"
          error={errorOf(state, 'file')}
          hint={t('fileHint')}
        >
          <Input id="symbol-file" name="file" type="file" accept=".svg,image/svg+xml" required />
        </Field>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <Switch name="colorize" defaultChecked className="mt-0.5" />
        <span>
          <span className="font-medium">{t('colorize')}</span>
          <span className="block text-xs text-muted-foreground">{t('colorizeHint')}</span>
        </span>
      </label>
      <SubmitButton>
        <Upload /> {t('upload')}
      </SubmitButton>
    </ActionForm>
  );
}
