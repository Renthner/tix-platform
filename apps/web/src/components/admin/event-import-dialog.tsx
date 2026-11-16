'use client';

import { Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Link, useRouter } from '@/i18n/navigation';
import { Field, NativeSelect } from './form-controls';

interface Summary {
  title: string;
  subtitle: string | null;
  exportedAt: string;
  timeZone: string;
  venueName: string | null;
  priceCategories: number;
  ticketTypes: number;
  fees: number;
  infoBoxes: number;
  ticketTemplates: number;
  emailTemplates: number;
  hasCover: boolean;
  seatPlan: { seats: number; sections: number } | null;
  taxRate: { name: string; rateBasisPoints: number };
}

type Warning =
  | { code: 'TAX_RATE_FALLBACK'; name: string }
  | { code: 'FEE_SKIPPED'; name: string }
  | { code: 'EMAIL_TEMPLATE_SKIPPED'; key: string; locale: string; reason: string };

interface Preview {
  summary: Summary;
  startsAtLocal: string;
}

const KNOWN_ERRORS = new Set([
  'EVENT_FILE_INVALID',
  'EVENT_VERSION_UNSUPPORTED',
  'EVENT_FILE_TOO_LARGE',
  'SEATMAP_FILE_INVALID',
  'MEDIA_UNSUPPORTED_TYPE',
  'MEDIA_TOO_LARGE',
  'MEDIA_DIMENSIONS',
  'MEDIA_UNDECODABLE',
  'SVG_INVALID',
  'SVG_EMPTY',
  'SVG_TOO_LARGE',
  'SVG_TOO_COMPLEX',
  'SLUG_TAKEN',
  'INVALID_SLUG',
  'INVALID_DATES',
  'INVALID_TITLE',
  'NOT_FOUND',
  'TAX_RATE_NOT_FOUND',
  'VALIDATION_FAILED',
]);

/** "Import event": upload a `.tixevent.json`, preview it and create a new draft event from it. */
export function EventImportDialog({ venues }: { venues: { id: string; name: string }[] }) {
  const t = useTranslations('admin.events.transfer.import');
  const te = useTranslations('admin.events');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [venueId, setVenueId] = useState('');
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ eventId: string; warnings: Warning[] } | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setError(null);
    setDone(null);
    setSlug('');
    if (input.current) input.current.value = '';
  };

  const send = async (mode: 'preview' | 'import', chosen: File) => {
    const body = new FormData();
    body.set('file', chosen);
    body.set('mode', mode);
    if (mode === 'import') {
      body.set('venueId', venueId);
      body.set('title', title.trim());
      if (slug.trim()) body.set('slug', slug.trim());
      // Only a changed start moves the other dates; the unchanged one keeps the file's dates.
      if (preview && startsAt && startsAt !== preview.startsAtLocal) body.set('startsAt', startsAt);
      body.set('defaultTicketTypeName', te('defaultTicketType'));
    }
    const response = await fetch('/api/admin/events/import', { method: 'POST', body });
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    if (!response.ok || !json) {
      const code = json?.error?.code ?? '';
      throw new Error(KNOWN_ERRORS.has(code) ? code : 'GENERIC');
    }
    return json;
  };

  const onPick = async (chosen: File | null) => {
    setPreview(null);
    setError(null);
    setFile(chosen);
    if (!chosen) return;
    setBusy(true);
    try {
      const json = (await send('preview', chosen)) as unknown as Preview;
      setPreview(json);
      setTitle(json.summary.title);
      setStartsAt(json.startsAtLocal);
      const match = venues.find((v) => v.name === json.summary.venueName);
      setVenueId((current) => match?.id ?? (current || venues[0]?.id || ''));
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
      const json = (await send('import', file)) as unknown as {
        eventId: string;
        warnings: Warning[];
      };
      if (json.warnings.length === 0) {
        router.push(`/admin/events/${json.eventId}?imported=1` as never);
        return;
      }
      setDone({ eventId: json.eventId, warnings: json.warnings });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GENERIC');
    } finally {
      setBusy(false);
    }
  };

  const s = preview?.summary;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Upload /> {t('button')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {venues.length === 0 ? (
          <Alert>
            <AlertDescription>{t('noVenues')}</AlertDescription>
          </Alert>
        ) : done ? (
          <div className="space-y-3">
            <Alert>
              <AlertDescription>
                <p className="mb-2 font-medium">{t('warningsTitle')}</p>
                <ul className="list-disc space-y-1 pl-5">
                  {done.warnings.map((w, i) => (
                    <li key={i}>{t(`warnings.${w.code}` as never, w as never)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button asChild>
                <Link href={`/admin/events/${done.eventId}`}>{t('openEvent')}</Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label={t('file')} htmlFor="eventImportFile">
              <Input
                id="eventImportFile"
                ref={input}
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
              />
            </Field>
            {busy && !preview && <p className="text-sm text-muted-foreground">{t('reading')}</p>}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${error}` as never)}
              </p>
            )}
            {s && preview && (
              <>
                <div className="space-y-1 rounded-md border p-3 text-sm">
                  <p className="font-medium">
                    {t('summary.from', {
                      title: s.title,
                      date: s.exportedAt.slice(0, 10),
                    })}
                  </p>
                  {s.venueName && (
                    <p className="text-muted-foreground">
                      {t('summary.sourceVenue', { venue: s.venueName })}
                    </p>
                  )}
                  <ul className="grid gap-1 pt-1 sm:grid-cols-2">
                    <li>
                      {s.seatPlan
                        ? t('summary.plan', {
                            seats: s.seatPlan.seats,
                            sections: s.seatPlan.sections,
                          })
                        : t('summary.noPlan')}
                    </li>
                    <li>{t('summary.categories', { count: s.priceCategories })}</li>
                    <li>{t('summary.tariffs', { count: s.ticketTypes })}</li>
                    <li>{t('summary.fees', { count: s.fees })}</li>
                    <li>{t('summary.boxes', { count: s.infoBoxes })}</li>
                    <li>{t('summary.templates', { count: s.ticketTemplates })}</li>
                    <li>{t('summary.mails', { count: s.emailTemplates })}</li>
                    {s.hasCover && <li>{t('summary.cover')}</li>}
                  </ul>
                  <p className="pt-1 text-muted-foreground">
                    {t('summary.tax', {
                      name: s.taxRate.name,
                      rate: s.taxRate.rateBasisPoints / 100,
                    })}
                  </p>
                </div>
                <Field label={t('fields.venue')} htmlFor="eventImportVenue" hint={t('venueHint')}>
                  <NativeSelect
                    id="eventImportVenue"
                    value={venueId}
                    onChange={(e) => setVenueId(e.target.value)}
                  >
                    {venues.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label={t('fields.title')} htmlFor="eventImportTitle">
                  <Input
                    id="eventImportTitle"
                    value={title}
                    maxLength={200}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
                <Field
                  label={t('fields.startsAt')}
                  htmlFor="eventImportStartsAt"
                  hint={t('startsAtHint', { timeZone: s.timeZone })}
                >
                  <Input
                    id="eventImportStartsAt"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </Field>
                <Field label={t('fields.slug')} htmlFor="eventImportSlug" hint={t('slugHint')}>
                  <Input
                    id="eventImportSlug"
                    value={slug}
                    maxLength={80}
                    autoComplete="off"
                    onChange={(e) => setSlug(e.target.value)}
                  />
                </Field>
                <div className="space-y-1 rounded-md bg-muted p-3 text-sm text-muted-foreground">
                  <p>{t('included')}</p>
                  <p>{t('notIncluded')}</p>
                </div>
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {tc('cancel')}
              </Button>
              <Button
                type="button"
                disabled={busy || !preview || !title.trim() || !venueId}
                onClick={() => void onImport()}
              >
                {busy && preview ? <Loader2 className="animate-spin" /> : <Upload />}{' '}
                {busy && preview ? t('pending') : t('submit')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
