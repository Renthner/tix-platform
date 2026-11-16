'use client';

import { Loader2, Replace } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRouter } from '@/i18n/navigation';
import { ConfirmDialog } from './confirm-dialog';
import { Field, NativeSelect } from './form-controls';

interface FileSummary {
  seats: number;
  sections: number;
  categories: { name: string }[];
}
interface Result {
  categoriesReused: number;
  categoriesCreated: number;
  unassignedSeats: number;
  scannerEntrancesCleared: number;
}

const KNOWN_ERRORS = new Set([
  'EVENT_NOT_DRAFT',
  'SEAT_PLAN_IN_USE',
  'SEAT_PLAN_HAS_HOLDS',
  'SEAT_PLAN_CONFLICT',
  'TEMPLATE_MISMATCH',
  'NOT_FOUND',
  'EVENT_NOT_FOUND',
  'SEATMAP_FILE_INVALID',
  'SEATMAP_VERSION_UNSUPPORTED',
  'SEATMAP_FILE_TOO_LARGE',
  'MEDIA_UNSUPPORTED_TYPE',
  'MEDIA_TOO_LARGE',
  'MEDIA_DIMENSIONS',
  'MEDIA_UNDECODABLE',
  'SVG_INVALID',
  'SVG_EMPTY',
  'SVG_TOO_LARGE',
  'SVG_TOO_COMPLEX',
  'VALIDATION_FAILED',
]);

/**
 * "Use a different seating plan" for a DRAFT event without orders: a copy of another venue plan or
 * an imported plan file. A confirm dialog states that the current plan copy is discarded.
 */
export function SeatPlanReplace({
  eventId,
  templates,
  blocked,
}: {
  eventId: string;
  templates: { id: string; name: string; seats: number }[];
  /** Why replacing is impossible right now (null = allowed). */
  blocked: 'notDraft' | 'inUse' | null;
}) {
  const t = useTranslations('admin.seating.replace');
  const router = useRouter();
  const [source, setSource] = useState<'template' | 'file'>(
    templates.length > 0 ? 'template' : 'file',
  );
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [fileSummary, setFileSummary] = useState<FileSummary | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const send = async (mode: 'preview' | 'replace', chosen: File | null) => {
    const body = new FormData();
    body.set('mode', mode);
    body.set('source', source);
    if (source === 'template') body.set('seatMapId', templateId);
    else if (chosen) body.set('file', chosen);
    const response = await fetch(`/api/admin/events/${eventId}/seat-plan`, {
      method: 'POST',
      body,
    });
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: string };
      summary?: FileSummary;
    } | null;
    if (!response.ok || !json) {
      const code = json?.error?.code ?? '';
      throw new Error(KNOWN_ERRORS.has(code) ? code : 'GENERIC');
    }
    return json;
  };

  const onPick = async (chosen: File | null) => {
    setFile(chosen);
    setFileSummary(null);
    setError(null);
    setResult(null);
    if (!chosen) return;
    setBusy(true);
    try {
      setFileSummary((await send('preview', chosen)).summary ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GENERIC');
    } finally {
      setBusy(false);
    }
  };

  const replace = async () => {
    setConfirm(false);
    setBusy(true);
    setError(null);
    try {
      const json = (await send('replace', file)) as unknown as Result;
      setResult(json);
      setFile(null);
      setFileSummary(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GENERIC');
    } finally {
      setBusy(false);
    }
  };

  if (blocked) {
    return (
      <div className="space-y-2 rounded-lg border p-4" data-testid="seat-plan-replace-blocked">
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <p className="text-sm text-muted-foreground">
          {blocked === 'notDraft' ? t('blockedNotDraft') : t('blockedInUse')}
        </p>
      </div>
    );
  }

  const ready = source === 'template' ? templateId !== '' : file !== null && fileSummary !== null;
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="seat-plan-replace">
      <div>
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        {(['template', 'file'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="seatPlanSource"
              checked={source === value}
              disabled={busy || (value === 'template' && templates.length === 0)}
              onChange={() => {
                setSource(value);
                setError(null);
                setResult(null);
              }}
            />
            {value === 'template' ? t('sourceTemplate') : t('sourceFile')}
          </label>
        ))}
      </div>
      {source === 'template' ? (
        templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noTemplates')}</p>
        ) : (
          <Field label={t('template')} htmlFor="replaceTemplate">
            <NativeSelect
              id="replaceTemplate"
              value={templateId}
              disabled={busy}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {t('templateOption', { name: tpl.name, seats: tpl.seats })}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )
      ) : (
        <Field label={t('file')} htmlFor="replaceFile">
          <Input
            id="replaceFile"
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
          />
        </Field>
      )}
      {source === 'file' && file && !fileSummary && busy && (
        <p className="text-sm text-muted-foreground">{t('reading')}</p>
      )}
      {fileSummary && (
        <p className="text-sm">
          {t('fileSummary', {
            seats: fileSummary.seats,
            sections: fileSummary.sections,
            categories: fileSummary.categories.length,
          })}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t('pricingNote')}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}` as never)}
        </p>
      )}
      {result && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">{t('done')}</p>
            <p>
              {t('doneDetails', {
                reused: result.categoriesReused,
                created: result.categoriesCreated,
                unassigned: result.unassignedSeats,
              })}
            </p>
            {result.scannerEntrancesCleared > 0 && (
              <p>{t('doneScanners', { count: result.scannerEntrancesCleared })}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy || !ready}
        onClick={() => setConfirm(true)}
      >
        {busy && !confirm ? <Loader2 className="animate-spin" /> : <Replace />}{' '}
        {busy && !confirm ? t('pending') : t('button')}
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('confirmTitle')}
        description={t('confirmDescription')}
        confirmLabel={t('confirm')}
        onConfirm={() => void replace()}
      />
    </div>
  );
}
