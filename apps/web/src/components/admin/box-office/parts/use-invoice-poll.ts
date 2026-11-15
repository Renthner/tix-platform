'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { SaleResult } from './types';

/** Invoice (issued by the worker shortly after the sale): polls until it exists. */
export function useInvoicePoll(sale: SaleResult | null) {
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [invoiceGaveUp, setInvoiceGaveUp] = useState(false);
  useEffect(() => {
    setInvoiceId(null);
    setInvoiceGaveUp(false);
    if (!sale || sale.payment === 'COMPLIMENTARY') return;
    let stopped = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const state = await apiFetch<{ invoiceId: string | null }>(
          `/api/admin/box-office/orders/${sale.orderId}`,
        );
        if (stopped) return;
        if (state.invoiceId) {
          setInvoiceId(state.invoiceId);
          return;
        }
      } catch {
        // keep polling
      }
      if (attempts >= 10) setInvoiceGaveUp(true);
      else timer = setTimeout(poll, 2000);
    };
    let timer = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sale]);
  return { invoiceId, invoiceGaveUp };
}
