'use client';

import { Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState, type DragEvent } from 'react';
import { NativeSelect } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

interface UploadResult {
  fileName: string;
  status: 'COMPLETED' | 'FAILED' | 'DUPLICATE_FILE' | 'UNSUPPORTED';
  format: string | null;
  transactionCount: number;
  importedCount: number;
  duplicateCount: number;
  errorMessage: string | null;
  warnings: string[];
  matched: number;
  review: number;
}

const UPLOAD_ERRORS = [
  'ACCOUNT_REQUIRED',
  'FILE_REQUIRED',
  'TOO_MANY_FILES',
  'FILE_TOO_LARGE',
  'ACCOUNT_NOT_FOUND',
] as const;

/** Drag & drop upload of statement files (posted to the import route handler). */
export function StatementUpload({
  accounts,
  defaultAccountId,
}: {
  accounts: { id: string; name: string; iban: string }[];
  defaultAccountId?: string;
}) {
  const t = useTranslations('banking.imports');
  const tStatus = useTranslations('banking.importStatus');
  const tErr = useTranslations('banking.errors.upload');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);

  if (accounts.length === 0)
    return <p className="text-sm text-muted-foreground">{t('noAccounts')}</p>;

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (list.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setResults([]);
    try {
      const body = new FormData();
      body.set('accountId', accountId);
      for (const file of list) body.append('files', file);
      const res = await fetch('/api/admin/banking/imports', { method: 'POST', body });
      const json = (await res.json().catch(() => null)) as
        { results: UploadResult[] } | { error: { code: string; message: string } } | null;
      if (!res.ok || !json || 'error' in json) {
        const code = json && 'error' in json ? json.error.code : '';
        setError(
          (UPLOAD_ERRORS as readonly string[]).includes(code)
            ? tErr(code as (typeof UPLOAD_ERRORS)[number])
            : tErr('generic'),
        );
      } else {
        setResults(json.results);
        router.refresh();
      }
    } catch {
      setError(tErr('generic'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files);
  };

  return (
    <div className="space-y-4">
      <div className="max-w-md space-y-1.5">
        <Label htmlFor="upload-account">{t('account')}</Label>
        <NativeSelect
          id="upload-account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.iban}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') input.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        aria-busy={busy}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center text-sm transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:bg-muted/40',
          busy && 'pointer-events-none opacity-60',
        )}
      >
        <Upload className="size-6 text-muted-foreground" />
        <span>{busy ? t('uploading') : dragging ? t('dropActive') : t('drop')}</span>
        <span className="text-xs text-muted-foreground">
          camt.053 · camt.052 · MT940 · CSV · ZIP
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".xml,.sta,.txt,.mt940,.940,.csv,.zip"
          onChange={(e) => e.target.files && void upload(e.target.files)}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{t('failed', { message: error })}</AlertDescription>
        </Alert>
      ) : null}
      {results.length > 0 ? (
        <div className="space-y-2">
          <div className="text-sm font-medium">{t('resultTitle')}</div>
          {results.map((r, i) => (
            <div key={`${r.fileName}-${i}`} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-all">{r.fileName}</span>
                <Badge
                  variant={
                    r.status === 'COMPLETED'
                      ? 'default'
                      : r.status === 'DUPLICATE_FILE'
                        ? 'secondary'
                        : 'destructive'
                  }
                >
                  {tStatus(r.status)}
                </Badge>
                {r.format ? <Badge variant="outline">{r.format}</Badge> : null}
              </div>
              {r.status === 'COMPLETED' ? (
                <p className="mt-1 text-muted-foreground">
                  {t('result', {
                    imported: r.importedCount,
                    duplicates: r.duplicateCount,
                    matched: r.matched,
                    review: r.review,
                  })}
                </p>
              ) : null}
              {r.errorMessage ? <p className="mt-1 text-destructive">{r.errorMessage}</p> : null}
              {r.warnings.length > 0 ? (
                <details className="mt-1 text-xs text-muted-foreground">
                  <summary>{t('warnings', { count: r.warnings.length })}</summary>
                  <ul className="list-disc pl-5">
                    {r.warnings.map((w, j) => (
                      <li key={j}>{w}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
