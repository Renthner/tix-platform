import {
  DomainError,
  cartGraceSeconds,
  customerAccountsOffered,
  extendCartForCheckout,
  getCheckoutOptions,
  getSetting,
  type CheckoutQuote,
  type PaymentMethodOption,
} from '@tix/core';
import { events } from '@tix/db';
import type { OnlinePaymentMethod } from '@tix/shared';
import { inArray } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { CheckoutForm } from '@/components/shop/checkout-form';
import { DraftCartNotice } from '@/components/shop/draft-cart-notice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Link, redirect } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { getCustomerSession } from '@/server/customer-session';
import { readSessionId } from '@/server/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('checkout');
  return { title: t('title'), robots: { index: false } };
}

export default async function CheckoutPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await resolveLocale(params);
  const core = getCore();
  const sid = await readSessionId();
  if (!sid) return redirect({ href: '/cart', locale });

  // Entering the checkout extends the reservation once by the payment grace period.
  const expiresAt = await extendCartForCheckout(core, sid);
  let options: {
    quotes: Record<OnlinePaymentMethod, CheckoutQuote>;
    methods: PaymentMethodOption[];
  };
  try {
    options = await getCheckoutOptions(core, sid, locale);
  } catch (err) {
    if (err instanceof DomainError && err.status < 500) return redirect({ href: '/cart', locale });
    throw err;
  }

  const eventIds = options.quotes.BANK_TRANSFER.events.map((e) => e.eventId);
  const [t, checkout, accounts, branding, customer, cartEvents, graceSeconds] = await Promise.all([
    getTranslations('checkout'),
    getSetting(core, 'checkout'),
    getSetting(core, 'customerAccounts'),
    getSetting(core, 'branding'),
    getCustomerSession(),
    core.db
      .select({ customerAccountsEnabled: events.customerAccountsEnabled })
      .from(events)
      .where(inArray(events.id, eventIds)),
    cartGraceSeconds(core, sid),
  ]);
  // Sign-in / registration can be hidden per event; guests can then always order.
  const accountsOffered = customerAccountsOffered(accounts, cartEvents);

  if (accountsOffered && !accounts.guestCheckoutEnabled && !customer) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <Card>
          <CardContent className="space-y-4 py-8 text-center">
            <p>{t('loginRequired')}</p>
            <div className="flex justify-center gap-2">
              <Button asChild>
                <Link href={`/account/login?next=${encodeURIComponent('/checkout')}`}>
                  {t('login')}
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/account/register?next=${encodeURIComponent('/checkout')}`}>
                  {t('register')}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <DraftCartNotice />
      <CheckoutForm
        locale={locale}
        quotes={options.quotes}
        methods={options.methods}
        expiresAt={expiresAt}
        requireTerms={checkout.requireTermsAcceptance}
        requirePhone={checkout.requirePhone}
        requireAddress={checkout.requireBillingAddress}
        termsUrl={branding.termsUrl ?? null}
        privacyUrl={branding.privacyUrl ?? null}
        accountsEnabled={accountsOffered}
        graceMinutes={Math.round(graceSeconds / 60)}
        customer={
          customer
            ? {
                email: customer.email,
                firstName: customer.firstName,
                lastName: customer.lastName,
                phone: customer.phone,
                address: customer.address,
              }
            : null
        }
      />
    </div>
  );
}
