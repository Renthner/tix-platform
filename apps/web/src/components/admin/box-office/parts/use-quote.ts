'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/api';
import type { Payment, Quote, SaleResult } from './types';

/** Debounced server quote for the current lines; cleared while empty or after a sale. */
export function useQuote(
  lines: Record<string, unknown>[],
  payment: Payment,
  allowBlocked: boolean,
  sale: SaleResult | null,
) {
  const tErr = useTranslations('common.errors');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    if (lines.length === 0 || sale) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoteBusy(true);
    const timer = setTimeout(() => {
      apiFetch<Quote>('/api/admin/box-office/quote', {
        method: 'POST',
        json: { lines, payment, allowBlocked },
      })
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          setQuoteError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(errorMessage(tErr, err));
        })
        .finally(() => {
          if (!cancelled) setQuoteBusy(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lines, payment, allowBlocked, sale, tErr]);

  return { quote, quoteBusy, quoteError };
}
