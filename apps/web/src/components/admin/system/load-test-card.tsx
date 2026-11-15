'use client';

import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { SettingsSection } from '@/components/admin/settings-forms';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Status {
  active: boolean;
  expiresAt?: string;
}

const ERROR_KEYS = {
  WRONG_PASSWORD: 'errors.WRONG_PASSWORD',
  TWO_FACTOR_REQUIRED: 'errors.TWO_FACTOR_REQUIRED',
  LOADTEST_ACTIVE: 'errors.LOADTEST_ACTIVE',
  RATE_LIMITED: 'errors.RATE_LIMITED',
  TWO_FACTOR_CODE_REQUIRED: 'errors.TWO_FACTOR_CODE_REQUIRED',
  TWO_FACTOR_INVALID: 'errors.TWO_FACTOR_INVALID',
  PASSKEY_INVALID: 'errors.PASSKEY_INVALID',
  ACCOUNT_LOCKED: 'errors.ACCOUNT_LOCKED',
} as const;
type ErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] | 'errors.failed';

/** System page: time-limited load test mode (skips the per-IP limits for a token-carrying generator). */
export function LoadTestCard({
  initial,
  passkeys,
}: {
  initial: Status;
  /** The admin has a passkey and the public URL allows WebAuthn. */
  passkeys: boolean;
}) {
  const t = useTranslations('system.loadTest');
  const format = useFormatter();
  const [status, setStatus] = useState<Status>(initial);
  const [token, setToken] = useState<string | null>(null);
  const [minutes, setMinutes] = useState('60');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [webauthn, setWebauthn] = useState(false);
  useEffect(() => setWebauthn(browserSupportsWebAuthn()), []);
  const canPasskey = passkeys && webauthn;
  const [error, setError] = useState<ErrorKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch('/api/admin/system/loadtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as Status & {
        token?: string;
        error?: { code?: string };
      };
      if (!response.ok) {
        const code = data.error?.code ?? '';
        setError(
          code in ERROR_KEYS ? ERROR_KEYS[code as keyof typeof ERROR_KEYS] : 'errors.failed',
        );
        return;
      }
      setStatus({ active: data.active, expiresAt: data.expiresAt });
      setToken(data.token ?? null);
      setPassword('');
      setCode('');
    } catch {
      setError('errors.failed');
    } finally {
      setBusy(false);
    }
  };

  /** Fresh passkey assertion (challenge bound to this action), then the normal enable call. */
  const enableWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const prepared = (await (
        await fetch('/api/admin/system/loadtest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'passkeyOptions' }),
        })
      )
        .json()
        .catch(() => ({}))) as { options?: never; challengeId?: string };
      if (!prepared.options || !prepared.challengeId) {
        setError('errors.PASSKEY_INVALID');
        return;
      }
      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: prepared.options });
      } catch (err) {
        const cancelled =
          err instanceof Error &&
          (err.name === 'NotAllowedError' ||
            err.name === 'AbortError' ||
            err.name === 'ERROR_CEREMONY_ABORTED');
        if (!cancelled) setError('errors.PASSKEY_INVALID');
        return;
      }
      await call({
        action: 'enable',
        durationMinutes: Number(minutes),
        password,
        passkeyChallengeId: prepared.challengeId,
        passkeyResponse: JSON.stringify(assertion),
      });
    } catch {
      setError('errors.failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="loadTest" title={t('title')} description={t('description')}>
      <div className="space-y-4" data-testid="load-test-card">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={status.active ? 'destructive' : 'secondary'}>
            {status.active ? t('statusOn') : t('statusOff')}
          </Badge>
          {status.active && status.expiresAt && (
            <span className="text-muted-foreground">
              {t('until', {
                time: format.dateTime(new Date(status.expiresAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{t(error)}</AlertDescription>
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
        {status.active ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirmDisable(true)}
          >
            {t('disable')}
          </Button>
        ) : (
          <form
            className="grid max-w-md gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void call({
                action: 'enable',
                durationMinutes: Number(minutes),
                password,
                ...(code ? { code } : {}),
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="loadtest-minutes">{t('duration')}</Label>
              <Input
                id="loadtest-minutes"
                type="number"
                min={5}
                max={240}
                step={5}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">{t('durationHint')}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="loadtest-password">{t('password')}</Label>
              <Input
                id="loadtest-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="loadtest-code">{t('code')}</Label>
              <Input
                id="loadtest-code"
                inputMode="text"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required={!canPasskey}
              />
              {canPasskey && <p className="text-xs text-muted-foreground">{t('passkeyHint')}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {canPasskey && (
                <Button
                  type="button"
                  disabled={busy || password.length === 0}
                  onClick={() => void enableWithPasskey()}
                >
                  {t('passkeySubmit')}
                </Button>
              )}
              <Button
                type="submit"
                variant={canPasskey ? 'outline' : 'default'}
                disabled={busy || password.length === 0 || (!canPasskey && code.length === 0)}
              >
                {t('enable')}
              </Button>
            </div>
          </form>
        )}
        <ConfirmDialog
          open={confirmDisable}
          onOpenChange={setConfirmDisable}
          description={t('disableConfirm')}
          confirmLabel={t('disable')}
          onConfirm={() => void call({ action: 'disable' })}
        />
      </div>
    </SettingsSection>
  );
}
