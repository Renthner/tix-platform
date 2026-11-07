'use client';

import { Check, Copy, Loader2, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useRouter } from '@/i18n/navigation';
import { apiFetch, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** A value with a copy-to-clipboard button (bank details on the order page). */
export function CopyValue({
  value,
  copyText,
  strong,
  mono,
}: {
  value: string;
  copyText?: string;
  strong?: boolean;
  mono?: boolean;
}) {
  const t = useTranslations('checkout.order');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText ?? value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('copyFailed'));
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn(strong && 'text-base font-semibold', mono && 'font-mono')}>{value}</span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={copy}
        aria-label={t('copy')}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </span>
  );
}

/** Pay a pending PayPal order (redirect to PayPal) or abandon it. */
export function OrderPaymentActions({ orderId, token }: { orderId: string; token: string | null }) {
  const t = useTranslations('checkout.order.paypal');
  const tErr = useTranslations('common.errors');
  const router = useRouter();
  const [pending, setPending] = useState<'pay' | 'cancel' | null>(null);

  const pay = async () => {
    setPending('pay');
    try {
      const { redirect } = await apiFetch<{ redirect: string }>(`/api/orders/${orderId}/paypal`, {
        method: 'POST',
        json: { t: token ?? undefined },
      });
      window.location.assign(redirect);
    } catch (err) {
      toast.error(errorMessage(tErr, err));
      setPending(null);
    }
  };

  const cancel = async () => {
    setPending('cancel');
    try {
      await apiFetch(`/api/orders/${orderId}/cancel`, {
        method: 'POST',
        json: { t: token ?? undefined },
      });
      toast.success(t('cancelled'));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(tErr, err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="lg" onClick={pay} disabled={pending !== null}>
        {pending === 'pay' ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Wallet className="size-4" />
        )}
        {t('pay')}
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" disabled={pending !== null}>
            {t('cancel')}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('cancelTitle')}</DialogTitle>
            <DialogDescription>{t('cancelText')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t('keep')}</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="destructive" onClick={cancel}>
                {t('cancelConfirm')}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
