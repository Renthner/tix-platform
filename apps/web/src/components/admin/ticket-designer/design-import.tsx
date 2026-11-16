'use client';

import { Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { NativeSelect } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRouter } from '@/i18n/navigation';

interface Summary {
  name: string;
  description: string | null;
  pageWidthMm: number;
  pageHeightMm: number;
  elements: number;
  images: number;
  hasBackground: boolean;
}

const KNOWN_ERRORS = new Set([
  'TICKET_DESIGN_FILE_INVALID',
  'TICKET_DESIGN_VERSION_UNSUPPORTED',
  'TICKET_DESIGN_FILE_TOO_LARGE',
  'MEDIA_UNSUPPORTED_TYPE',
  'MEDIA_TOO_LARGE',
  'MEDIA_DIMENSIONS',
  'MEDIA_UNDECODABLE',
  'EVENT_NOT_FOUND',
  'CATEGORY_NOT_FOUND',
]);

/**
 * Upload a `.tixticket.json` file, preview it and import it as a new design (library design, or
 * a design of `eventId` that can be assigned to the event / a price category right away).
 */
export function TicketDesignImport({
  eventId,
  categories = [],
}: {
  eventId?: string;
  categories?: { id: string; name: string }[];
}) {
  const t = useTranslations('ticketDesigner.transfer');
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [name, setName] = useState('');
  const [assignTo, setAssignTo] = useState(eventId ? 'event' : 'none');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (mode: 'preview' | 'import', chosen: File) => {
    const body = new FormData();
    body.set('file', chosen);
    body.set('mode', mode);
    if (eventId) {
      body.set('eventId', eventId);
      body.set('assignTo', assignTo);
    }
    if (mode === 'import' && name.trim()) body.set('name', name.trim());
    const response = await fetch('/api/admin/ticket-templates/import', { method: 'POST', body });
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: string };
      summary?: Summary;
      templateId?: string;
    } | null;
    if (!response.ok || !json) {
      const code = json?.error?.code ?? '';
      throw new Error(KNOWN_ERRORS.has(code) ? code : 'GENERIC');
    }
    return json;
  };

  const onPick = async (chosen: File | null) => {
    setSummary(null);
    setError(null);
    setFile(chosen);
    if (!chosen) return;
    setBusy(true);
    try {
      const json = await send('preview', chosen);
      setSummary(json.summary!);
      setName(json.summary!.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GENERIC');
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const json = await send('import', file);
      router.push(`/admin/ticket-templates/${json.templateId}` as never);
    } catch (err) {
      // The form (file, name, assignment) stays as it is so the admin can correct and retry.
      setError(err instanceof Error ? err.message : 'GENERIC');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{t('title')}</h3>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Input
        type="file"
        accept=".json,application/json"
        aria-label={t('file')}
        disabled={busy}
        onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}` as never)}
        </p>
      )}
      {summary && (
        <div className="space-y-3">
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            <li>
              {t('summary.size', { width: summary.pageWidthMm, height: summary.pageHeightMm })}
            </li>
            <li>{t('summary.elements', { count: summary.elements })}</li>
            <li>{t('summary.images', { count: summary.images })}</li>
            <li>{summary.hasBackground ? t('summary.background') : t('summary.noBackground')}</li>
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <label htmlFor="design-import-name" className="mb-1 block text-sm font-medium">
                {t('name')}
              </label>
              <Input
                id="design-import-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {eventId && (
              <div className="min-w-56 flex-1">
                <label htmlFor="design-import-assign" className="mb-1 block text-sm font-medium">
                  {t('assignTo')}
                </label>
                <NativeSelect
                  id="design-import-assign"
                  value={assignTo}
                  onChange={(e) => setAssignTo(e.target.value)}
                >
                  <option value="event">{t('assignEvent')}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t('assignCategory', { name: c.name })}
                    </option>
                  ))}
                  <option value="none">{t('assignNone')}</option>
                </NativeSelect>
              </div>
            )}
            <Button type="button" disabled={busy || !name.trim()} onClick={() => void onImport()}>
              {busy ? <Loader2 className="animate-spin" /> : <Upload />} {t('submit')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
