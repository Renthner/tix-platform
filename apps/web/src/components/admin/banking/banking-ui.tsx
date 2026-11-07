'use client';

import type { BankSyncStatus, BankTxMatchStatus, BankTxReviewReason } from '@tix/shared';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import type { BankingActionState, BankingFieldError } from '@/lib/banking-action-state';
import { cn } from '@/lib/utils';

export function bankingError(
  state: BankingActionState,
  name: string,
): BankingFieldError | undefined {
  return state.status === 'error' ? state.fieldErrors?.[name] : undefined;
}

/** Form field with label, hint and a translated banking validation error. */
export function BankField({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  error?: BankingFieldError;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations('banking.errors.field');
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {t(error)}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Money placeholders (cents + currency) in success messages are formatted here. */
function useMessageValues() {
  const format = useFormatter();
  return (values: Record<string, number | string> | undefined) => {
    if (!values) return {};
    const currency = typeof values.currency === 'string' ? values.currency : 'EUR';
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(values)) {
      out[key] =
        typeof value === 'number' && ['outstanding', 'overpayment', 'unassigned'].includes(key)
          ? format.number(value / 100, { style: 'currency', currency })
          : value;
    }
    return out;
  };
}

/** Toast on success, alert for form-level errors (with the provider's detail message). */
export function BankingFeedback({ state }: { state: BankingActionState }) {
  const t = useTranslations('banking');
  const values = useMessageValues();
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'idle' || state.at === lastAt.current) return;
    lastAt.current = state.at;
    if (state.status === 'success')
      toast.success(t(`messages.${state.message}`, values(state.values)));
    else if (!state.formError) toast.error(t('errors.form.generic'));
  }, [state, t, values]);
  if (state.status !== 'error' || !state.formError) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {t(`errors.form.${state.formError}`)}
        {state.detail ? <span className="mt-1 block font-mono text-xs">{state.detail}</span> : null}
      </AlertDescription>
    </Alert>
  );
}

/** Re-renders the server components periodically while something runs in the background. */
export function AutoRefresh({
  active,
  intervalMs = 3000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}

const MATCH_VARIANT: Record<
  BankTxMatchStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  UNMATCHED: 'outline',
  AUTO_MATCHED: 'default',
  MANUALLY_MATCHED: 'secondary',
  NEEDS_REVIEW: 'destructive',
  IGNORED: 'outline',
};

export function MatchStatusBadge({ status }: { status: BankTxMatchStatus }) {
  const t = useTranslations('banking.status');
  return <Badge variant={MATCH_VARIANT[status]}>{t(status)}</Badge>;
}

export function ReasonBadge({ reason }: { reason: BankTxReviewReason }) {
  const t = useTranslations('banking');
  return (
    <Badge variant="outline" title={t(`reasonHint.${reason}`)}>
      {t(`reason.${reason}`)}
    </Badge>
  );
}

const SYNC_VARIANT: Record<BankSyncStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  RUNNING: 'secondary',
  SUCCEEDED: 'default',
  FAILED: 'destructive',
  TAN_REQUIRED: 'destructive',
  CANCELLED: 'outline',
};

export function SyncStatusBadge({ status }: { status: BankSyncStatus | null }) {
  const t = useTranslations('banking.syncStatus');
  if (!status) return <Badge variant="outline">{t('never')}</Badge>;
  return <Badge variant={SYNC_VARIANT[status]}>{t(status)}</Badge>;
}

export function Money({
  cents,
  currency,
  signed = false,
  className,
}: {
  cents: number;
  currency: string;
  signed?: boolean;
  className?: string;
}) {
  const format = useFormatter();
  return (
    <span
      className={cn(
        'tabular-nums',
        signed && cents > 0 && 'text-emerald-700 dark:text-emerald-400',
        signed && cents < 0 && 'text-destructive',
        className,
      )}
    >
      {format.number(cents / 100, {
        style: 'currency',
        currency,
        ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
      })}
    </span>
  );
}

const TABS = [
  { href: '/admin/banking', key: 'overview', exact: true },
  { href: '/admin/banking/review', key: 'review', exact: false },
  { href: '/admin/banking/transactions', key: 'transactions', exact: false },
  { href: '/admin/banking/imports', key: 'imports', exact: false },
  { href: '/admin/banking/accounts', key: 'accounts', exact: false },
] as const;

export function BankingTabs({ reviewCount }: { reviewCount: number }) {
  const t = useTranslations('banking.tabs');
  const pathname = usePathname();
  const accountsActive = pathname.startsWith('/admin/banking/connections');
  return (
    <nav className="flex gap-1 overflow-x-auto border-b px-6" aria-label={t('label')}>
      {TABS.map(({ href, key, exact }) => {
        const active =
          (exact ? pathname === href : pathname.startsWith(href)) ||
          (key === 'accounts' && accountsActive);
        return (
          <Link
            key={key}
            href={href}
            className={cn(
              '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors',
              active
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(key)}
            {key === 'review' && reviewCount > 0 ? (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                {reviewCount}
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
