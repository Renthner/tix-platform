'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Settings → Security: token of the Prometheus endpoint (shown once, stored encrypted). */
export function MetricsTokenCard({ enabled: initialEnabled }: { enabled: boolean }) {
  const t = useTranslations('system.security');
  const [enabled, setEnabled] = useState(initialEnabled);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const call = async (action: 'generate' | 'clear') => {
    setBusy(true);
    setError(false);
    setCopied(false);
    try {
      const response = await fetch('/api/admin/system/metrics-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { enabled: boolean; token?: string };
      setEnabled(body.enabled);
      setToken(body.token ?? null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant={enabled ? 'default' : 'secondary'}>
          {enabled ? t('statusOn') : t('statusOff')}
        </Badge>
        <span className="text-muted-foreground">{t('intro')}</span>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t('failed')}</AlertDescription>
        </Alert>
      )}
      {token && (
        <div className="space-y-2 rounded-md border p-3" role="status">
          <div className="text-sm font-medium">{t('tokenTitle')}</div>
          <div className="flex gap-2">
            <Input
              readOnly
              value={token}
              className="font-mono text-xs"
              onFocus={(e) => e.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(token).then(() => setCopied(true));
              }}
            >
              {copied ? t('copied') : t('copy')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('tokenHint')}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => void call('generate')}>
          {enabled ? t('regenerate') : t('generate')}
        </Button>
        {enabled && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('removeConfirm'))) void call('clear');
            }}
          >
            {t('remove')}
          </Button>
        )}
      </div>
    </div>
  );
}
