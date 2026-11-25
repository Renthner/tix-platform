'use client';

import { Clock, TimerOff, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { useCart } from './cart-context';

/** Warning this long before the reservation ends. */
const WARN_BEFORE_MS = 120_000;

/**
 * Reservation notices for the whole shop: a warning about two minutes before the cart timer runs
 * out, and a persistent notice once it did (also after a redirect from /cart or /checkout with
 * `?expired=1`). Both are live regions.
 */
export function ReservationNotices() {
  const t = useTranslations('cart.expiry');
  const { cart, refresh, expired, dismissExpired } = useCart();
  const params = useSearchParams();
  const [dismissedRedirect, setDismissedRedirect] = useState(false);
  // The expiry time the warning was confirmed for (the checkout extension moves the expiry).
  const [warnedFor, setWarnedFor] = useState<number | null>(null);
  const [warningDismissed, setWarningDismissed] = useState<number | null>(null);

  const expiresAt = cart?.itemCount ? cart.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => {
        // Re-check with fresh data: the checkout may have extended the reservation meanwhile.
        void refresh().then((fresh) => {
          if (
            fresh?.itemCount &&
            fresh.expiresAt &&
            fresh.expiresAt - Date.now() <= WARN_BEFORE_MS + 5_000
          )
            setWarnedFor(fresh.expiresAt);
        });
      },
      Math.max(0, expiresAt - Date.now() - WARN_BEFORE_MS),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, refresh]);

  const fromRedirect =
    params.get('expired') === '1' && !dismissedRedirect && cart !== null && cart.itemCount === 0;
  const showExpired = !!expired || fromRedirect;
  const showWarning =
    !showExpired &&
    expiresAt !== null &&
    warnedFor === expiresAt &&
    warningDismissed !== expiresAt &&
    expiresAt > Date.now();

  if (!showExpired && !showWarning) return null;

  if (showExpired) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 pt-4" data-testid="reservation-expired">
        <Alert variant="destructive" role="alert">
          <TimerOff className="size-4" />
          <AlertTitle>{t('expiredTitle')}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{t('expiredText')}</span>
            {expired?.eventSlug ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/events/${expired.eventSlug}`}>{t('backToEvent')}</Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href="/">{t('browseEvents')}</Link>
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto size-8"
              aria-label={t('dismiss')}
              onClick={() => {
                dismissExpired();
                setDismissedRedirect(true);
              }}
            >
              <X className="size-4" />
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-4" data-testid="reservation-warning">
      <Alert role="status">
        <Clock className="size-4" />
        <AlertTitle>{t('warningTitle')}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{t('warningText')}</span>
          <Button asChild size="sm" variant="outline">
            <Link href="/cart">{t('toCart')}</Link>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-8"
            aria-label={t('dismiss')}
            onClick={() => setWarningDismissed(expiresAt)}
          >
            <X className="size-4" />
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
