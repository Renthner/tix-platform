'use client';

import { ShoppingCart, Timer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/i18n/navigation';
import { formatCountdown } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCart } from './cart-context';

export function CartCountdown({ expiresAt, className }: { expiresAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = expiresAt - now;
  return (
    <span
      className={cn(
        'tabular-nums',
        remaining < 60_000 && 'font-semibold text-destructive',
        className,
      )}
      aria-live="off"
    >
      {formatCountdown(remaining)}
    </span>
  );
}

/** Cart link with item count and the visible reservation countdown. */
export function HeaderCart() {
  const t = useTranslations('cart');
  const { cart } = useCart();
  const count = cart?.itemCount ?? 0;
  return (
    <Link
      href="/cart"
      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
    >
      <ShoppingCart className="size-4" />
      <span className="hidden sm:inline">{t('title')}</span>
      {count > 0 && <Badge>{count}</Badge>}
      {count > 0 && cart?.expiresAt && (
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title={t('summary.reservedFor')}
        >
          <Timer className="size-3.5" />
          <CartCountdown expiresAt={cart.expiresAt} />
        </span>
      )}
    </Link>
  );
}
