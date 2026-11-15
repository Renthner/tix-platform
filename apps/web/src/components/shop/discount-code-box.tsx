'use client';

import type { CartDiscountPreview } from '@tix/core';
import { Tag, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch, errorCode } from '@/lib/api';
import { useMoney } from '@/lib/format';

const REASONS = [
  'INVALID',
  'NOT_STARTED',
  'EXPIRED',
  'USAGE_LIMIT',
  'EMAIL_LIMIT',
  'NOT_STACKABLE',
  'NOT_VALID_FOR_ITEMS',
  'MIN_ORDER_VALUE',
  'PERCENT_CAP',
  'BELOW_MINIMUM_TOTAL',
  'RATE_LIMITED',
  'GENERIC',
] as const;
type Reason = (typeof REASONS)[number];

/** Message key of a discount error code (`DISCOUNT_EXPIRED` -> `EXPIRED`). */
function reasonOf(code: string): Reason {
  const reason = code.replace(/^DISCOUNT_/, '');
  return (REASONS as readonly string[]).includes(reason) ? (reason as Reason) : 'GENERIC';
}

/**
 * "Discount code" field of the cart / checkout: apply and remove codes, show the discount of each
 * applied code and why a code of the cart stopped applying. `onChange` runs after a code was added
 * or removed (the parent refreshes its prices); `onPreview` hands the current preview to the parent.
 */
export function DiscountCodeBox({
  onChange,
  onPreview,
}: {
  onChange?: () => void;
  onPreview?: (preview: CartDiscountPreview) => void;
}) {
  const t = useTranslations('discount');
  const locale = useLocale();
  const money = useMoney();
  const [preview, setPreview] = useState<CartDiscountPreview | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<Reason | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<CartDiscountPreview>(`/api/cart/discount?locale=${locale}`);
      setPreview(next);
      onPreview?.(next);
    } catch {
      /* the cart itself reports problems */
    }
  }, [locale, onPreview]);
  useEffect(() => {
    void load();
  }, [load]);

  const apply = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/cart/discount', { method: 'POST', json: { code } });
      setCode('');
      await load();
      onChange?.();
    } catch (err) {
      setError(reasonOf(errorCode(err)));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (value: string) => {
    setBusy(true);
    try {
      await apiFetch('/api/cart/discount', { method: 'DELETE', json: { code: value } });
      await load();
      onChange?.();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  const currency = preview?.currency ?? 'EUR';
  return (
    <div className="space-y-2 text-sm" data-testid="discount-box">
      <div className="flex items-center gap-1.5 font-medium">
        <Tag className="size-4" /> {t('title')}
      </div>
      {/* Not a <form>: the box also sits inside the checkout form. */}
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void apply();
            }
          }}
          placeholder={t('placeholder')}
          aria-label={t('title')}
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={64}
          className="uppercase"
          data-testid="discount-input"
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !code.trim()}
          onClick={() => void apply()}
          data-testid="discount-apply"
        >
          {t('apply')}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert" data-testid="discount-error">
          {t(`errors.${error}` as 'errors.INVALID')}
        </p>
      )}
      {preview?.applied.map((d) => (
        <div
          key={d.code}
          className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5"
        >
          <span className="font-mono">{d.code}</span>
          <span className="flex items-center gap-2 tabular-nums">
            −{money(d.amount, currency)}
            <button
              type="button"
              onClick={() => void remove(d.code)}
              aria-label={t('remove', { code: d.code })}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </div>
      ))}
      {preview?.rejected.map((r) => (
        <div
          key={r.code}
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive"
        >
          <span>
            <span className="font-mono">{r.code}</span>:{' '}
            {t(`errors.${reasonOf(`DISCOUNT_${r.reason}`)}` as 'errors.INVALID')}
          </span>
          <button
            type="button"
            onClick={() => void remove(r.code)}
            aria-label={t('remove', { code: r.code })}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
