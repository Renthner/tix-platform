'use client';

import type { CartEventView, CartItemView } from '@tix/core';
import { Info, Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { apiFetch, errorCode, errorMessage } from '@/lib/api';
import { useEventDate, useMoney } from '@/lib/format';
import { useCart } from './cart-context';
import { CartCountdown } from './header-cart';

/** Multi-event cart: one card per event, tariff chosen per seat / standing spot. */
export function CartView() {
  const t = useTranslations('cart');
  const { cart, refresh } = useCart();
  const money = useMoney();

  if (!cart) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
      </div>
    );
  }
  if (cart.itemCount === 0) {
    return (
      <Card>
        <CardContent className="space-y-4 py-10 text-center">
          <p className="text-muted-foreground">{t('empty')}</p>
          <Button asChild>
            <Link href="/">{t('browseEvents')}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const currency = cart.currencies[0] ?? 'EUR';
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {cart.events.map((event) => (
          <CartEventCard key={event.eventId} event={event} onChange={refresh} />
        ))}
      </div>
      <aside>
        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>{t('summary.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {cart.expiresAt && (
              <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
                <span>{t('summary.reservedFor')}</span>
                <CartCountdown expiresAt={cart.expiresAt} />
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span>{t('summary.tickets', { count: cart.itemCount })}</span>
              <span className="tabular-nums">{money(cart.totalGross, currency)}</span>
            </div>
            <div className="flex items-center justify-between border-t pt-3 font-semibold">
              <span>{t('summary.total')}</span>
              <span className="tabular-nums">{money(cart.totalGross, currency)}</span>
            </div>
            <p className="text-xs text-muted-foreground">{t('summary.feesNote')}</p>
            {cart.currencies.length > 1 ? (
              <p className="text-xs text-destructive">{t('summary.mixedCurrencies')}</p>
            ) : (
              <Button asChild size="lg" className="w-full">
                <Link href="/checkout">{t('summary.checkout')}</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function CartEventCard({
  event,
  onChange,
}: {
  event: CartEventView;
  onChange: () => Promise<unknown>;
}) {
  const t = useTranslations('cart');
  const money = useMoney();
  const date = useEventDate();
  const types = new Map(event.ticketTypes.map((tt) => [tt.id, tt]));
  const needsProof = event.items.some((i) => types.get(i.ticketTypeId)?.requiresProofAtEntry);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">
          <Link href={`/events/${event.slug}`} className="hover:underline">
            {event.title}
          </Link>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {date(event.startsAt, event.timeZone)} · {event.venueName}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y">
          {event.items.map((item) => (
            <CartItemRow key={item.key} event={event} item={item} onChange={onChange} />
          ))}
        </ul>
        {needsProof && (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <Info className="mt-0.5 size-3.5 shrink-0" /> {t('proofNote')}
          </p>
        )}
        <div className="flex items-center justify-between pt-1 text-sm">
          <Link href={`/events/${event.slug}`} className="text-muted-foreground hover:underline">
            {t('editSeats')}
          </Link>
          <span className="font-medium tabular-nums">
            {money(event.subtotalGross, event.currency)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function CartItemRow({
  event,
  item,
  onChange,
}: {
  event: CartEventView;
  item: CartItemView;
  onChange: () => Promise<unknown>;
}) {
  const t = useTranslations('cart');
  const tErr = useTranslations('common.errors');
  const money = useMoney();
  const [pending, setPending] = useState(false);
  const allowed = event.ticketTypes.filter((tt) => item.allowedTicketTypeIds.includes(tt.id));
  const current = event.ticketTypes.find((tt) => tt.id === item.ticketTypeId);

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
      await onChange();
    } catch (err) {
      const code = errorCode(err);
      toast.error(errorMessage(tErr, err));
    } finally {
      setPending(false);
    }
  };

  const place =
    item.kind === 'SEAT'
      ? [
          item.sectionLabel,
          item.rowLabel ? t('row', { label: item.rowLabel }) : null,
          t('seat', { label: item.seatLabel ?? '' }),
        ]
          .filter(Boolean)
          .join(' · ')
      : [item.sectionLabel, t('standing')].filter(Boolean).join(' · ');

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span
        className="inline-block size-3 shrink-0 rounded-full"
        style={{ background: item.categoryColor }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{place}</div>
        <div className="text-xs text-muted-foreground">{item.categoryName}</div>
      </div>
      <Select
        value={item.ticketTypeId}
        disabled={pending || allowed.length < 2}
        onValueChange={(ticketTypeId) =>
          run(() =>
            apiFetch('/api/cart/tariff', {
              method: 'PATCH',
              json: { eventId: event.eventId, itemKey: item.key, ticketTypeId },
            }),
          )
        }
      >
        <SelectTrigger className="w-48" aria-label={t('tariff')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowed.map((tt) => (
            <SelectItem key={tt.id} value={tt.id}>
              {tt.name} · {money(tt.prices[item.categoryId] ?? 0, event.currency)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current?.requiresProofAtEntry && <Badge variant="outline">{t('proofBadge')}</Badge>}
      <span className="w-20 text-right text-sm tabular-nums">
        {money(item.priceGross, event.currency)}
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('remove')}
        disabled={pending}
        onClick={() =>
          run(() =>
            apiFetch('/api/cart/items', {
              method: 'DELETE',
              json: { eventId: event.eventId, itemKey: item.key },
            }),
          )
        }
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}
