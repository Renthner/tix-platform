'use client';

import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import {
  passkeyLoginOptionsAction,
  passkeyLoginVerifyAction,
  passkeySecondFactorOptionsAction,
  passkeySecondFactorVerifyAction,
  pendingPasskeysAction,
  type LoginState,
} from '@/app/[locale]/admin/login/actions';
import { Button } from '@/components/ui/button';

/** True when the ceremony was cancelled / timed out by the user (nothing to report). */
function isCancelled(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'NotAllowedError' ||
    err.name === 'AbortError' ||
    err.name === 'ERROR_CEREMONY_ABORTED'
  );
}

/**
 * "Sign in with passkey" (`login`: usernameless, replaces the password) or "Use a passkey" as the
 * second step after the password (`second-factor`, only shown when the user has one). Success
 * redirects (server action); failures are reported through `onError` (null = nothing to show).
 * `shopNext` is set by the shop's sign-in form only.
 */
export function PasskeyButton({
  mode,
  label,
  onError,
  disabled,
  shopNext,
  variant = 'outline',
}: {
  mode: 'login' | 'second-factor';
  label: string;
  onError: (error: LoginState['error']) => void;
  disabled?: boolean;
  shopNext?: string | null;
  variant?: 'outline' | 'default' | 'ghost';
}) {
  const [supported, setSupported] = useState(false);
  const [offered, setOffered] = useState(mode === 'login');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);
  useEffect(() => {
    if (mode !== 'second-factor') return;
    let live = true;
    void pendingPasskeysAction().then((has) => {
      if (live) setOffered(has);
    });
    return () => {
      live = false;
    };
  }, [mode]);

  if (!supported || !offered) return null;

  const shop = shopNext === undefined ? null : { next: shopNext };
  const run = async () => {
    setBusy(true);
    onError(null);
    try {
      const prepared =
        mode === 'login'
          ? await passkeyLoginOptionsAction()
          : await passkeySecondFactorOptionsAction();
      if (!prepared.ok) {
        onError(prepared.error);
        return;
      }
      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: prepared.options });
      } catch (err) {
        if (!isCancelled(err)) onError('PASSKEY_FAILED');
        return;
      }
      const result =
        mode === 'login'
          ? await passkeyLoginVerifyAction(prepared.challengeId, assertion, shop)
          : await passkeySecondFactorVerifyAction(prepared.challengeId, assertion, shop);
      onError(result.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      className="w-full"
      disabled={disabled || busy}
      onClick={run}
    >
      {label}
    </Button>
  );
}
