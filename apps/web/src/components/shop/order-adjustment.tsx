'use client';

import { Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { apiFetch, errorMessage } from '@/lib/api';

/** "Zahlungspflichtig bestätigen": the customer accepts the additional payment. */
export function AdjustmentConfirmButton({
  orderId,
  adjustmentId,
  token,
}: {
  orderId: string;
  adjustmentId: string;
  token: string | null;
}) {
  const t = useTranslations('checkout.order.adjustment');
  const tErr = useTranslations('common.errors');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    setPending(true);
    try {
      await apiFetch(`/api/orders/${orderId}/adjustment/confirm`, {
        method: 'POST',
        json: { t: token ?? undefined, adjustmentId },
      });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(tErr, err));
    } finally {
      setPending(false);
    }
  };
  return (
    <Button size="lg" onClick={confirm} disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
      {t('confirm')}
    </Button>
  );
}

/** Pay the confirmed additional payment with PayPal (redirect). */
export function AdjustmentPayPalButton({
  orderId,
  adjustmentId,
  token,
}: {
  orderId: string;
  adjustmentId: string;
  token: string | null;
}) {
  const t = useTranslations('checkout.order.adjustment');
  const tErr = useTranslations('common.errors');
  const [pending, setPending] = useState(false);
  const pay = async () => {
    setPending(true);
    try {
      const { redirect } = await apiFetch<{ redirect: string }>(
        `/api/orders/${orderId}/adjustment/paypal`,
        { method: 'POST', json: { t: token ?? undefined, adjustmentId } },
      );
      window.location.assign(redirect);
    } catch (err) {
      toast.error(errorMessage(tErr, err));
      setPending(false);
    }
  };
  return (
    <Button size="lg" onClick={pay} disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
      {t('payPaypal')}
    </Button>
  );
}
