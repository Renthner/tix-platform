'use client';

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ErrorAlert } from '@/components/admin/auth/password-link-forms';
import { ActionForm, Field, SubmitButton } from '@/components/admin/form-controls';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SECURITY_IDLE, type SecurityState } from '@/lib/security-state';
import type { PasskeyBeginResult, PasskeyProofOptions } from '@/server/admin/account';
import { RecoveryCodes, useSuccessToast } from './account-forms';

type Action = (state: SecurityState, fd: FormData) => Promise<SecurityState>;

export interface PasskeyRowData {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

function PasskeyRow({
  passkey,
  renameAction,
  removeAction,
  removeLocked,
}: {
  passkey: PasskeyRowData;
  renameAction: Action;
  removeAction: Action;
  removeLocked: boolean;
}) {
  const t = useTranslations('adminSecurity.passkeys');
  const format = useFormatter();
  const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view');
  const [renameState, rename] = useActionState(renameAction, SECURITY_IDLE);
  const [removeState, remove] = useActionState(removeAction, SECURITY_IDLE);
  useSuccessToast(renameState);
  useSuccessToast(removeState);
  useEffect(() => {
    if (renameState.status === 'success') setMode('view');
  }, [renameState]);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{passkey.name}</p>
          <p className="text-xs text-muted-foreground">
            {t('added', { date: date(passkey.createdAt) })} ·{' '}
            {passkey.lastUsedAt
              ? t('lastUsed', { date: date(passkey.lastUsedAt) })
              : t('neverUsed')}
            {passkey.backedUp ? ` · ${t('synced')}` : ''}
          </p>
        </div>
        {mode === 'view' && (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setMode('rename')}>
              {t('rename')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={removeLocked}
              title={removeLocked ? t('removeLocked') : undefined}
              onClick={() => setMode('remove')}
            >
              {t('remove')}
            </Button>
          </div>
        )}
      </div>
      {mode === 'rename' && (
        <ActionForm action={rename} className="space-y-3">
          <ErrorAlert state={renameState} />
          <input type="hidden" name="id" value={passkey.id} />
          <Field label={t('name')} htmlFor={`rename-${passkey.id}`}>
            <Input
              id={`rename-${passkey.id}`}
              name="name"
              defaultValue={passkey.name}
              maxLength={80}
              required
              autoFocus
            />
          </Field>
          <div className="flex gap-2">
            <SubmitButton size="sm">{t('save')}</SubmitButton>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              {t('cancel')}
            </Button>
          </div>
        </ActionForm>
      )}
      {mode === 'remove' && (
        <ActionForm action={remove} className="space-y-3">
          <ErrorAlert state={removeState} />
          <input type="hidden" name="id" value={passkey.id} />
          <Field label={t('password')} htmlFor={`remove-${passkey.id}`} hint={t('removeHint')}>
            <Input
              id={`remove-${passkey.id}`}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </Field>
          <div className="flex gap-2">
            <SubmitButton variant="destructive" size="sm">
              {t('removeConfirm')}
            </SubmitButton>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              {t('cancel')}
            </Button>
          </div>
        </ActionForm>
      )}
    </li>
  );
}

/** Own passkeys: list, add (password re-confirmation + browser ceremony), rename, remove. */
export function PasskeyPanel({
  available,
  passkeys,
  removeLocked,
  hasSecondFactor,
  hasTotp,
  beginAction,
  finishAction,
  renameAction,
  removeAction,
  proofOptionsAction,
  regenerateAction,
}: {
  /** The public URL allows WebAuthn (https or localhost, domain name). */
  available: boolean;
  passkeys: PasskeyRowData[];
  /** The last passkey is the only second factor and two-factor authentication is mandatory. */
  removeLocked: boolean;
  /** The account already has a second factor: adding another one needs proof of it. */
  hasSecondFactor: boolean;
  /** An authenticator app exists (its recovery codes are managed in the panel above). */
  hasTotp: boolean;
  beginAction: (password: string, proof?: unknown) => Promise<PasskeyBeginResult>;
  finishAction: (challengeId: string, response: unknown, name: string) => Promise<SecurityState>;
  renameAction: Action;
  removeAction: Action;
  proofOptionsAction: (purpose: 'add-passkey' | 'recovery-codes') => Promise<PasskeyProofOptions>;
  regenerateAction: (password: string, proof: unknown) => Promise<SecurityState>;
}) {
  const t = useTranslations('adminSecurity.passkeys');
  const tTotp = useTranslations('adminSecurity.twoFactor');
  const router = useRouter();
  const [supported, setSupported] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<SecurityState>(SECURITY_IDLE);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenState, setRegenState] = useState<SecurityState>(SECURITY_IDLE);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);

  if (codes) {
    return (
      <div className="max-w-md space-y-4">
        <Alert>
          <AlertDescription>{t('addedNow')}</AlertDescription>
        </Alert>
        <RecoveryCodes codes={codes} />
        <Button
          type="button"
          onClick={() => {
            setCodes(null);
            router.refresh();
          }}
        >
          {tTotp('done')}
        </Button>
      </div>
    );
  }

  /** A typed code, or (code left empty) a fresh assertion of an existing passkey. */
  const collectProof = async (
    code: string,
    purpose: 'add-passkey' | 'recovery-codes',
  ): Promise<{ proof: unknown } | { error: SecurityState } | null> => {
    if (code.trim() !== '') return { proof: { code } };
    if (passkeys.length === 0)
      return { error: { status: 'error', code: 'INVALID_CODE', at: Date.now() } };
    const prepared = await proofOptionsAction(purpose);
    if (!prepared.ok) return { error: prepared.state };
    try {
      const response = await startAuthentication({ optionsJSON: prepared.options });
      return { proof: { passkey: { challengeId: prepared.challengeId, response } } };
    } catch (err) {
      const cancelled =
        err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      if (cancelled) return null;
      return { error: { status: 'error', code: 'PASSKEY_INVALID', at: Date.now() } };
    }
  };

  const regen = async (formData: FormData) => {
    const password = String(formData.get('password') ?? '');
    setBusy(true);
    setRegenState(SECURITY_IDLE);
    try {
      const collected = await collectProof(String(formData.get('code') ?? ''), 'recovery-codes');
      if (!collected) return;
      if ('error' in collected) {
        setRegenState(collected.error);
        return;
      }
      const result = await regenerateAction(password, collected.proof);
      setRegenState(result);
      if (result.status === 'success' && result.recoveryCodes?.length) {
        toast.success(t('regenerated'));
        setCodes(result.recoveryCodes);
        setRegenerating(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const add = async (formData: FormData) => {
    const password = String(formData.get('password') ?? '');
    const name = String(formData.get('name') ?? '').trim() || t('defaultName');
    setBusy(true);
    setState(SECURITY_IDLE);
    try {
      let proof: unknown;
      if (hasSecondFactor) {
        const collected = await collectProof(String(formData.get('code') ?? ''), 'add-passkey');
        if (!collected) return;
        if ('error' in collected) {
          setState(collected.error);
          return;
        }
        proof = collected.proof;
      }
      const begin = await beginAction(password, proof);
      if (!begin.ok) {
        setState(begin.state);
        return;
      }
      let attestation;
      try {
        attestation = await startRegistration({ optionsJSON: begin.options });
      } catch (err) {
        const cancelled =
          err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
        if (!cancelled) setState({ status: 'error', code: 'PASSKEY_INVALID', at: Date.now() });
        return;
      }
      const result = await finishAction(begin.challengeId, attestation, name);
      setState(result);
      if (result.status === 'success') {
        toast.success(t('addedToast'));
        setAdding(false);
        if (result.recoveryCodes?.length) setCodes(result.recoveryCodes);
        else router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      {!available ? (
        <Alert>
          <AlertDescription>{t('unavailable')}</AlertDescription>
        </Alert>
      ) : (
        !supported && (
          <Alert>
            <AlertDescription>{t('unsupported')}</AlertDescription>
          </Alert>
        )
      )}
      {passkeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="space-y-3">
          {passkeys.map((p) => (
            <PasskeyRow
              key={p.id}
              passkey={p}
              renameAction={renameAction}
              removeAction={removeAction}
              removeLocked={removeLocked && passkeys.length === 1}
            />
          ))}
        </ul>
      )}
      {available && supported && !adding && (
        <Button type="button" onClick={() => setAdding(true)}>
          {t('add')}
        </Button>
      )}
      {available && supported && adding && (
        <ActionForm action={add} className="space-y-3 rounded-md border p-3">
          <ErrorAlert state={state} />
          <Field label={t('name')} htmlFor="passkey-name" hint={t('nameHint')}>
            <Input id="passkey-name" name="name" maxLength={80} autoFocus />
          </Field>
          <Field label={t('password')} htmlFor="passkey-password" hint={t('addHint')}>
            <Input
              id="passkey-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          {hasSecondFactor && (
            <Field
              label={t('proofCode')}
              htmlFor="passkey-code"
              hint={passkeys.length > 0 ? t('proofHintOptional') : t('proofHint')}
            >
              <Input
                id="passkey-code"
                name="code"
                autoComplete="one-time-code"
                maxLength={64}
                required={passkeys.length === 0}
              />
            </Field>
          )}
          <div className="flex gap-2">
            <SubmitButton disabled={busy} pendingLabel={t('adding')}>
              {t('create')}
            </SubmitButton>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              {t('cancel')}
            </Button>
          </div>
        </ActionForm>
      )}
      {available && supported && passkeys.length > 0 && !hasTotp && (
        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-semibold">{t('regenerateTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('regenerateHint')}</p>
          {!regenerating ? (
            <Button type="button" variant="outline" onClick={() => setRegenerating(true)}>
              {t('regenerate')}
            </Button>
          ) : (
            <ActionForm action={regen} className="space-y-3 rounded-md border p-3">
              <ErrorAlert state={regenState} />
              <Field label={t('password')} htmlFor="passkey-regen-password">
                <Input
                  id="passkey-regen-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field
                label={t('proofCode')}
                htmlFor="passkey-regen-code"
                hint={t('proofHintOptional')}
              >
                <Input
                  id="passkey-regen-code"
                  name="code"
                  autoComplete="one-time-code"
                  maxLength={64}
                />
              </Field>
              <div className="flex gap-2">
                <SubmitButton disabled={busy} pendingLabel={t('adding')}>
                  {t('regenerateConfirm')}
                </SubmitButton>
                <Button type="button" variant="ghost" onClick={() => setRegenerating(false)}>
                  {t('cancel')}
                </Button>
              </div>
            </ActionForm>
          )}
        </div>
      )}
    </div>
  );
}
