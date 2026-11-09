'use client';

import type { CheckoutQuote, PaymentMethodOption, QuoteItem } from '@tix/core';
import type { OnlinePaymentMethod, PostalAddress } from '@tix/shared';
import {
  AlertCircle,
  Info,
  Landmark,
  Loader2,
  LogIn,
  UserCheck,
  UserPlus,
  Wallet,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Link, useRouter } from '@/i18n/navigation';
import { apiFetch, errorCode, errorMessage } from '@/lib/api';
import { useEventDate, useMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCart } from './cart-context';
import { CartCountdown } from './header-cart';

const COUNTRIES = [
  'DE',
  'AT',
  'CH',
  'LU',
  'NL',
  'BE',
  'FR',
  'DK',
  'PL',
  'CZ',
  'IT',
  'ES',
  'GB',
  'US',
];
const METHOD_ICON = { PAYPAL: Wallet, BANK_TRANSFER: Landmark } as const;
/** Errors after which the cart has to be reviewed before ordering again. */
const CART_ERRORS = new Set([
  'CART_EMPTY',
  'CART_EXPIRED',
  'CART_CHANGED',
  'CART_OUTDATED',
  'SEAT_UNAVAILABLE',
  'SECTION_SOLD_OUT',
  'SELECTION_INVALID',
  'COMPANION_OWNER_MISMATCH',
]);

interface Props {
  locale: 'en' | 'de';
  quotes: Record<OnlinePaymentMethod, CheckoutQuote>;
  methods: PaymentMethodOption[];
  expiresAt: number | null;
  requireTerms: boolean;
  /** Phone number / billing address are mandatory (checkout setting). */
  requirePhone: boolean;
  requireAddress: boolean;
  termsUrl: string | null;
  privacyUrl: string | null;
  /** Sign-in / registration offered (global setting and no event of the cart hides it). */
  accountsEnabled: boolean;
  /** Payment grace period added once when the checkout was opened (minutes). */
  graceMinutes: number;
  customer: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    address: PostalAddress | null;
  } | null;
}

export function CheckoutForm(props: Props) {
  const t = useTranslations('checkout');
  const tErr = useTranslations('common.errors');
  const router = useRouter();
  const { refresh: refreshCart } = useCart();
  const available = props.methods.filter((m) => m.available);
  const [method, setMethod] = useState<OnlinePaymentMethod | null>(available[0]?.method ?? null);
  const [form, setForm] = useState({
    email: props.customer?.email ?? '',
    firstName: props.customer?.firstName ?? '',
    lastName: props.customer?.lastName ?? '',
    company: '',
    phone: props.customer?.phone ?? '',
    customerNote: '',
  });
  const [withAddress, setWithAddress] = useState(
    props.requireAddress || Boolean(props.customer?.address),
  );
  const [address, setAddress] = useState<PostalAddress>(
    props.customer?.address ?? {
      street: '',
      addressLine2: '',
      postalCode: '',
      city: '',
      country: 'DE',
    },
  );
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const quote = method ? props.quotes[method] : props.quotes.BANK_TRANSFER;

  // Entering the checkout extended the reservation – let the header countdown pick it up.
  useEffect(() => {
    void refreshCart().catch(() => undefined);
  }, [refreshCart]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!method || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await apiFetch<{ redirect: string }>('/api/checkout', {
        method: 'POST',
        json: {
          method,
          ...form,
          address:
            withAddress || props.requireAddress
              ? { ...address, addressLine2: address.addressLine2 || undefined }
              : undefined,
          acceptTerms,
          expectedTotalGross: quote.totalGross,
          locale: props.locale,
        },
      });
      await refreshCart().catch(() => undefined);
      window.location.assign(result.redirect);
    } catch (err) {
      const code = errorCode(err);
      const message = errorMessage(tErr, err);
      setError({ code, message });
      toast.error(message);
      // New prices / availability: re-render the server part, the form keeps its input.
      if (code === 'PRICE_CHANGED' || code === 'PAYMENT_METHOD_UNAVAILABLE') router.refresh();
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_380px]" noValidate>
      <div className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {error.message}
              {CART_ERRORS.has(error.code) && (
                <Link href="/cart" className="font-medium underline">
                  {t('backToCart')}
                </Link>
              )}
              {error.code === 'LOGIN_REQUIRED' && (
                <Link
                  href={`/account/login?next=${encodeURIComponent('/checkout')}`}
                  className="font-medium underline"
                >
                  {t('login')}
                </Link>
              )}
            </AlertDescription>
          </Alert>
        )}

        {props.accountsEnabled && !props.customer && <AccountBox />}
        {props.customer && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
            <UserCheck className="size-5 text-primary" />
            <span className="flex-1">
              {t('account.signedInAs', {
                name: `${props.customer.firstName} ${props.customer.lastName}`,
                email: props.customer.email,
              })}
            </span>
            <Link href="/account" className="font-medium underline">
              {t('account.myAccount')}
            </Link>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t('contact.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FieldBox id="co-first" label={t('contact.firstName')}>
              <Input
                id="co-first"
                autoComplete="given-name"
                required
                maxLength={100}
                value={form.firstName}
                onChange={set('firstName')}
              />
            </FieldBox>
            <FieldBox id="co-last" label={t('contact.lastName')}>
              <Input
                id="co-last"
                autoComplete="family-name"
                required
                maxLength={100}
                value={form.lastName}
                onChange={set('lastName')}
              />
            </FieldBox>
            <FieldBox id="co-email" label={t('contact.email')} hint={t('contact.emailHint')}>
              <Input
                id="co-email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                readOnly={Boolean(props.customer)}
                value={form.email}
                onChange={set('email')}
              />
            </FieldBox>
            <FieldBox
              id="co-phone"
              label={t('contact.phone')}
              optional={props.requirePhone ? undefined : t('optional')}
              error={error?.code === 'PHONE_REQUIRED' ? error.message : undefined}
            >
              <Input
                id="co-phone"
                type="tel"
                autoComplete="tel"
                required={props.requirePhone}
                aria-invalid={error?.code === 'PHONE_REQUIRED' || undefined}
                maxLength={50}
                // Mirrors PHONE_PATTERN (escaped for the browser's `v`-flag pattern syntax).
                pattern="[0-9+\(\)\/.\- ]{5,50}"
                title={t('contact.phoneHint')}
                value={form.phone}
                onChange={set('phone')}
              />
            </FieldBox>
            {!props.requireAddress && (
              <div className="flex items-center gap-2 sm:col-span-2">
                <Checkbox
                  id="co-address"
                  checked={withAddress}
                  onCheckedChange={(v) => setWithAddress(v === true)}
                />
                <Label htmlFor="co-address" className="font-normal">
                  {t('address.toggle')}
                </Label>
              </div>
            )}
            {(withAddress || props.requireAddress) && (
              <>
                <FieldBox id="co-company" label={t('address.company')} optional={t('optional')}>
                  <Input
                    id="co-company"
                    autoComplete="organization"
                    maxLength={200}
                    value={form.company}
                    onChange={set('company')}
                  />
                </FieldBox>
                <FieldBox
                  id="co-street"
                  label={t('address.street')}
                  error={error?.code === 'ADDRESS_REQUIRED' ? error.message : undefined}
                >
                  <Input
                    id="co-street"
                    required
                    autoComplete="address-line1"
                    maxLength={200}
                    value={address.street}
                    onChange={(e) => setAddress((a) => ({ ...a, street: e.target.value }))}
                  />
                </FieldBox>
                <FieldBox id="co-line2" label={t('address.line2')} optional={t('optional')}>
                  <Input
                    id="co-line2"
                    autoComplete="address-line2"
                    maxLength={200}
                    value={address.addressLine2 ?? ''}
                    onChange={(e) => setAddress((a) => ({ ...a, addressLine2: e.target.value }))}
                  />
                </FieldBox>
                <div className="grid grid-cols-[120px_1fr] gap-4">
                  <FieldBox id="co-zip" label={t('address.postalCode')}>
                    <Input
                      id="co-zip"
                      required
                      autoComplete="postal-code"
                      maxLength={20}
                      value={address.postalCode}
                      onChange={(e) => setAddress((a) => ({ ...a, postalCode: e.target.value }))}
                    />
                  </FieldBox>
                  <FieldBox id="co-city" label={t('address.city')}>
                    <Input
                      id="co-city"
                      required
                      autoComplete="address-level2"
                      maxLength={120}
                      value={address.city}
                      onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                    />
                  </FieldBox>
                </div>
                <FieldBox id="co-country" label={t('address.country')}>
                  <CountrySelect
                    locale={props.locale}
                    value={address.country}
                    onChange={(country) => setAddress((a) => ({ ...a, country }))}
                  />
                </FieldBox>
              </>
            )}
            <div className="sm:col-span-2">
              <FieldBox id="co-note" label={t('contact.note')} optional={t('optional')}>
                <Textarea
                  id="co-note"
                  rows={2}
                  maxLength={1000}
                  value={form.customerNote}
                  onChange={set('customerNote')}
                />
              </FieldBox>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('payment.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {available.length === 0 && (
              <Alert variant="destructive">
                <AlertDescription>{t('payment.noneAvailable')}</AlertDescription>
              </Alert>
            )}
            {props.methods.map((option) => (
              <MethodCard
                key={option.method}
                option={option}
                quote={props.quotes[option.method]}
                selected={method === option.method}
                onSelect={() => setMethod(option.method)}
              />
            ))}
          </CardContent>
        </Card>
      </div>

      <aside>
        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>{t('summary.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {props.expiresAt && (
              <div className="space-y-1 rounded-md bg-muted px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{t('summary.reservedFor')}</span>
                  <CartCountdown expiresAt={props.expiresAt} />
                </div>
                {props.graceMinutes > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('summary.graceNote', { minutes: props.graceMinutes })}
                  </p>
                )}
              </div>
            )}
            <QuoteSummary quote={quote} />
            {props.requireTerms && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="co-terms"
                  className="mt-0.5"
                  checked={acceptTerms}
                  onCheckedChange={(v) => setAcceptTerms(v === true)}
                />
                <Label htmlFor="co-terms" className="block text-sm leading-snug font-normal">
                  {t.rich('terms', {
                    terms: (chunks) =>
                      props.termsUrl ? (
                        <a
                          href={props.termsUrl}
                          target="_blank"
                          rel="noopener"
                          className="underline"
                        >
                          {chunks}
                        </a>
                      ) : (
                        chunks
                      ),
                    privacy: (chunks) =>
                      props.privacyUrl ? (
                        <a
                          href={props.privacyUrl}
                          target="_blank"
                          rel="noopener"
                          className="underline"
                        >
                          {chunks}
                        </a>
                      ) : (
                        chunks
                      ),
                  })}
                </Label>
              </div>
            )}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={pending || !method || (props.requireTerms && !acceptTerms)}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {method === 'PAYPAL' ? t('submitPayPal') : t('submit')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {method === 'PAYPAL' ? t('submitHintPayPal') : t('submitHintBankTransfer')}
            </p>
          </CardContent>
        </Card>
      </aside>
    </form>
  );
}

/** Prominent sign-in / registration offer (guests can still continue below). */
function AccountBox() {
  const t = useTranslations('checkout.account');
  const next = encodeURIComponent('/checkout');
  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
        <div className="flex-1 space-y-1">
          <div className="text-base font-semibold">{t('title')}</div>
          <p className="text-sm text-muted-foreground">{t('text')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:w-56">
          <Button asChild size="lg">
            <Link href={`/account/login?next=${next}`}>
              <LogIn className="size-4" /> {t('login')}
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="bg-background">
            <Link href={`/account/register?next=${next}`}>
              <UserPlus className="size-4" /> {t('register')}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FieldBox({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="font-normal text-muted-foreground"> ({optional})</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function CountrySelect({
  locale,
  value,
  onChange,
}: {
  locale: string;
  value: string;
  onChange: (country: string) => void;
}) {
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: 'region' }), [locale]);
  const options = COUNTRIES.includes(value) ? COUNTRIES : [value, ...COUNTRIES];
  return (
    <select
      id="co-country"
      autoComplete="country"
      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((code) => (
        <option key={code} value={code}>
          {names.of(code) ?? code}
        </option>
      ))}
    </select>
  );
}

function MethodCard({
  option,
  quote,
  selected,
  onSelect,
}: {
  option: PaymentMethodOption;
  quote: CheckoutQuote;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations('checkout.payment');
  const money = useMoney();
  const Icon = METHOD_ICON[option.method];
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
        selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent/50',
        !option.available && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name="method"
        className="mt-1 accent-primary"
        checked={selected}
        disabled={!option.available}
        onChange={onSelect}
      />
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{t(`methods.${option.method}.label`)}</span>
          <span className="text-sm font-medium tabular-nums">
            {money(option.totalGross, quote.currency)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {option.available
            ? t(`methods.${option.method}.description`)
            : t(`unavailable.${option.reason ?? 'DISABLED'}`)}
        </p>
        {option.available && option.feeTotal > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('feesIncluded', { amount: money(option.feeTotal, quote.currency) })}
          </p>
        )}
      </div>
    </label>
  );
}

function itemPlace(t: ReturnType<typeof useTranslations<'checkout'>>, item: QuoteItem): string {
  return item.kind === 'SEAT'
    ? [
        item.sectionLabel,
        item.rowLabel ? t('item.row', { label: item.rowLabel }) : null,
        t('item.seat', { label: item.seatLabel ?? '' }),
      ]
        .filter(Boolean)
        .join(' · ')
    : [item.sectionLabel, t('item.standing')].filter(Boolean).join(' · ');
}

/** Itemised price summary of a quote (tickets per event, fees, total, included VAT). */
export function QuoteSummary({ quote }: { quote: CheckoutQuote }) {
  const t = useTranslations('checkout');
  const money = useMoney();
  const date = useEventDate();
  const taxes = new Map<number, number>();
  for (const event of quote.events) {
    for (const item of event.items)
      taxes.set(
        item.taxRateBasisPoints,
        (taxes.get(item.taxRateBasisPoints) ?? 0) + item.taxAmount,
      );
    for (const fee of event.fees)
      taxes.set(fee.taxRateBasisPoints, (taxes.get(fee.taxRateBasisPoints) ?? 0) + fee.totalTax);
  }
  for (const fee of quote.orderFees)
    taxes.set(fee.taxRateBasisPoints, (taxes.get(fee.taxRateBasisPoints) ?? 0) + fee.totalTax);
  const proof = quote.events.some((e) => e.items.some((i) => i.requiresProofAtEntry));

  return (
    <div className="space-y-4 text-sm">
      {quote.events.map((event) => (
        <div key={event.eventId} className="space-y-2">
          <div>
            <div className="font-medium">{event.title}</div>
            <div className="text-xs text-muted-foreground">
              {date(event.startsAt, event.timeZone)} · {event.venueName}
            </div>
          </div>
          <ul className="space-y-1.5">
            {event.items.map((item) => (
              <li key={item.key} className="flex justify-between gap-3">
                <div className="min-w-0">
                  <div>{itemPlace(t, item)}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.categoryName} · {item.ticketTypeName}
                    {item.requiresProofAtEntry && (
                      <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]">
                        {t('item.proof')}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="text-right tabular-nums">
                  {item.discountAmount > 0 && (
                    <div className="text-xs text-muted-foreground line-through">
                      {money(item.unitPriceGross, quote.currency)}
                    </div>
                  )}
                  {money(item.priceGross, quote.currency)}
                </div>
              </li>
            ))}
            {event.fees.map((fee) => (
              <li key={fee.feeId} className="flex justify-between gap-3 text-muted-foreground">
                <span>
                  {fee.name}
                  {fee.quantity > 1 && ` (${fee.quantity}×)`}
                </span>
                <span className="tabular-nums">{money(fee.totalGross, quote.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {quote.orderFees.length > 0 && (
        <ul className="space-y-1.5 border-t pt-3">
          {quote.orderFees.map((fee) => (
            <li key={fee.feeId} className="flex justify-between gap-3 text-muted-foreground">
              <span>{fee.name}</span>
              <span className="tabular-nums">{money(fee.totalGross, quote.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between border-t pt-3 text-base font-semibold">
        <span>{t('summary.total')}</span>
        <span className="tabular-nums">{money(quote.totalGross, quote.currency)}</span>
      </div>
      {[...taxes.entries()]
        .filter(([rate, amount]) => rate > 0 && amount > 0)
        .sort((a, b) => b[0] - a[0])
        .map(([rate, amount]) => (
          <div key={rate} className="flex justify-between text-xs text-muted-foreground">
            <span>{t('summary.vat', { rate: rate / 100 })}</span>
            <span className="tabular-nums">{money(amount, quote.currency)}</span>
          </div>
        ))}
      {proof && (
        <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <Info className="mt-0.5 size-3.5 shrink-0" /> {t('proofNote')}
        </p>
      )}
    </div>
  );
}
