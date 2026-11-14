'use client';

import { ExternalLink, RefreshCw } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { ActionForm, SubmitButton } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BANKING_IDLE, type BankingActionState } from '@/lib/banking-action-state';
import { BankField, BankingFeedback, bankingError } from './banking-ui';

type Action = (state: BankingActionState, fd: FormData) => Promise<BankingActionState>;

/** One-button action form (sync now, check status, test login …). */
export function BankingActionButton({
  action,
  label,
  variant = 'outline',
  icon,
  disabled,
}: {
  action: Action;
  label: string;
  variant?: 'default' | 'outline' | 'secondary';
  icon?: 'refresh';
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, BANKING_IDLE);
  return (
    <ActionForm action={formAction} className="space-y-2">
      <SubmitButton variant={variant} size="sm" disabled={disabled}>
        {icon === 'refresh' ? <RefreshCw /> : null}
        {label}
      </SubmitButton>
      <BankingFeedback state={state} />
    </ActionForm>
  );
}

/** finAPI: open the web form (bank login / consent renewal) in a new tab. */
export function FinApiConnectButton({
  action,
  label,
  pendingUrl,
}: {
  action: Action;
  label: string;
  /** Still-open web form from an earlier attempt. */
  pendingUrl: string | null;
}) {
  const t = useTranslations('banking.connection.finapi');
  const [state, formAction] = useActionState(action, BANKING_IDLE);
  const [url, setUrl] = useState<string | null>(pendingUrl);
  useEffect(() => {
    if (state.status === 'success' && state.url) {
      setUrl(state.url);
      window.open(state.url, '_blank', 'noopener,noreferrer');
    }
  }, [state]);
  return (
    <ActionForm action={formAction} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton size="sm">{label}</SubmitButton>
        {url ? (
          <Button asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> {t('openWebForm')}
            </a>
          </Button>
        ) : null}
      </div>
      <BankingFeedback state={state} />
    </ActionForm>
  );
}

export interface TanChallengeView {
  id: string;
  connectionName: string;
  status: string;
  tanMethod: string | null;
  challengeText: string | null;
  challengeMediaMimeType: string | null;
  challengeMediaBase64: string | null;
  isDecoupled: boolean;
  expiresAt: string;
}

/** PSD2 TAN prompt: the worker keeps the bank dialog open until the admin answers here. */
export function TanPrompt({
  challenge,
  submitTan,
  confirmApproval,
  cancel,
}: {
  challenge: TanChallengeView;
  submitTan: Action;
  confirmApproval: Action;
  cancel: Action;
}) {
  const t = useTranslations('banking.tan');
  const format = useFormatter();
  const [tanState, tanAction] = useActionState(submitTan, BANKING_IDLE);
  const [approveState, approveAction] = useActionState(confirmApproval, BANKING_IDLE);
  const [cancelState, cancelAction] = useActionState(cancel, BANKING_IDLE);
  const time = format.dateTime(new Date(challenge.expiresAt), { timeStyle: 'short' });
  const submitted = challenge.status === 'SUBMITTED';
  const image =
    challenge.challengeMediaBase64 &&
    /^image\/(png|jpeg|gif|bmp)$/.test(challenge.challengeMediaMimeType ?? '')
      ? `data:${challenge.challengeMediaMimeType};base64,${challenge.challengeMediaBase64}`
      : null;
  return (
    <div
      className="space-y-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      role="alert"
    >
      <h3 className="font-medium">{t('title', { connection: challenge.connectionName })}</h3>
      <p className="text-sm text-muted-foreground">
        {challenge.isDecoupled ? t('decoupledIntro', { time }) : t('intro', { time })}
      </p>
      {challenge.tanMethod ? (
        <p className="text-xs text-muted-foreground">{challenge.tanMethod}</p>
      ) : null}
      {challenge.challengeText ? (
        <p className="whitespace-pre-wrap rounded-md bg-background p-3 text-sm">
          {challenge.challengeText}
        </p>
      ) : null}
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- inline data URL from the bank
        <img
          src={image}
          alt={t('challengeImage')}
          className="max-h-64 rounded-md border bg-paper p-2"
        />
      ) : null}
      {submitted ? (
        <p className="text-sm font-medium">{t('submitted')}</p>
      ) : challenge.isDecoupled ? (
        <div className="flex flex-wrap gap-2">
          <ActionForm action={approveAction}>
            <SubmitButton size="sm">{t('approved')}</SubmitButton>
          </ActionForm>
          <ActionForm action={cancelAction}>
            <SubmitButton size="sm" variant="outline">
              {t('cancel')}
            </SubmitButton>
          </ActionForm>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <ActionForm action={tanAction} className="flex flex-wrap items-end gap-2">
            <BankField
              label={t('tan')}
              htmlFor={`tan-${challenge.id}`}
              error={bankingError(tanState, 'tan')}
            >
              <Input
                id={`tan-${challenge.id}`}
                name="tan"
                inputMode="text"
                autoComplete="one-time-code"
                maxLength={32}
                className="w-40 font-mono"
                autoFocus
              />
            </BankField>
            <SubmitButton size="sm">{t('submit')}</SubmitButton>
          </ActionForm>
          <ActionForm action={cancelAction}>
            <SubmitButton size="sm" variant="outline">
              {t('cancel')}
            </SubmitButton>
          </ActionForm>
        </div>
      )}
      <BankingFeedback state={tanState} />
      <BankingFeedback state={approveState} />
      <BankingFeedback state={cancelState} />
    </div>
  );
}
