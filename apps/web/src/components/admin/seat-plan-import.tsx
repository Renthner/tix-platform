'use client';

import { Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRouter } from '@/i18n/navigation';

interface Summary {
  name: string;
  exportedAt: string;
  sections: number;
  seatedSections: number;
  standingSections: number;
  rows: number;
  seats: number;
  elements: number;
  entrances: number;
  symbols: number;
  categories: { name: string; color: string }[];
  hasBackground: boolean;
  images: number;
}

const KNOWN_ERRORS = new Set([
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
]);

/** Upload a `.tixplan.json` file, preview what it contains and import it as a new master plan. */
export function SeatPlanImport({ venueId }: { venueId: string }) {
  const t = useTranslations('admin.venues.import');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (mode: 'preview' | 'import', chosen: File) => {
    const body = new FormData();
    body.set('file', chosen);
    body.set('mode', mode);
    body.set('venueId', venueId);
    if (mode === 'import' && name.trim()) body.set('name', name.trim());
    const response = await fetch('/api/admin/seat-maps/import', { method: 'POST', body });
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: string };
      summary?: Summary;
      seatMapId?: string;
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
      router.push(`/admin/seat-maps/${json.seatMapId}` as never);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GENERIC');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{t('title')}</h3>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="flex items-center gap-2">
        <Input
          ref={input}
          type="file"
          accept=".json,application/json"
          aria-label={t('file')}
          disabled={busy}
          onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}` as never)}
        </p>
      )}
      {summary && (
        <div className="space-y-3">
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            <li>{t('summary.sections', { count: summary.sections })}</li>
            <li>{t('summary.rows', { count: summary.rows })}</li>
            <li>{t('summary.seats', { count: summary.seats })}</li>
            <li>{t('summary.elements', { count: summary.elements })}</li>
            <li>{t('summary.symbols', { count: summary.symbols })}</li>
            <li>{summary.hasBackground ? t('summary.background') : t('summary.noBackground')}</li>
          </ul>
          {summary.categories.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('categoriesNote', { names: summary.categories.map((c) => c.name).join(', ') })}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <label htmlFor="import-name" className="mb-1 block text-sm font-medium">
                {t('name')}
              </label>
              <Input
                id="import-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="button" disabled={busy || !name.trim()} onClick={() => void onImport()}>
              {busy ? <Loader2 className="animate-spin" /> : <Upload />} {t('submit')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
