'use client';

import { BellRing, CheckCircle2, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch, errorCode } from '@/lib/api';

interface Props {
  eventId: string;
  /** The whole event is sold out (any category can be chosen). */
  soldOut: boolean;
  categories: { id: string; name: string }[];
  maxTickets: number;
}

const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** "Join the waiting list" form of a sold-out event (double opt-in e-mail follows). */
export function WaitlistCard({ eventId, soldOut, categories, maxTickets }: Props) {
  const t = useTranslations('shop.waitlist');
  const tErr = useTranslations('common.errors');
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<'CONFIRMATION_SENT' | 'ALREADY_ON_LIST' | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const category = String(form.get('categoryId') ?? '');
      const response = await apiFetch<{ status: 'CONFIRMATION_SENT' | 'ALREADY_ON_LIST' }>(
        `/api/events/${eventId}/waitlist`,
        {
          method: 'POST',
          json: {
            email: String(form.get('email') ?? ''),
            firstName: String(form.get('firstName') ?? '') || undefined,
            quantity: Number(form.get('quantity') ?? 1),
            categoryId: category || null,
            website: String(form.get('website') ?? ''),
            locale,
          },
        },
      );
      setResult(response.status);
    } catch (err) {
      const code = errorCode(err);
      setError(tErr.has(code as never) ? tErr(code as never) : tErr('INTERNAL_ERROR'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-slot="waitlist">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-5" aria-hidden />
          {soldOut ? t('soldOutTitle') : t('categoryTitle')}
        </CardTitle>
        <CardDescription>{t('intro')}</CardDescription>
      </CardHeader>
      <CardContent>
        {result ? (
          <Alert data-slot="waitlist-sent">
            <CheckCircle2 />
            <AlertTitle>{t('sentTitle')}</AlertTitle>
            <AlertDescription>
              {result === 'ALREADY_ON_LIST' ? t('already') : t('sent')}
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="waitlist-email">{t('email')}</Label>
              <Input
                id="waitlist-email"
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="waitlist-name">{t('firstName')}</Label>
              <Input
                id="waitlist-name"
                name="firstName"
                maxLength={100}
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="waitlist-quantity">{t('quantity')}</Label>
              <Input
                id="waitlist-quantity"
                name="quantity"
                type="number"
                min={1}
                max={maxTickets}
                defaultValue={Math.min(2, maxTickets)}
                required
              />
            </div>
            {categories.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="waitlist-category">{t('category')}</Label>
                <select
                  id="waitlist-category"
                  name="categoryId"
                  className={selectClass}
                  defaultValue={soldOut ? '' : (categories[0]?.id ?? '')}
                >
                  {soldOut && <option value="">{t('anyCategory')}</option>}
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {/* Honeypot for bots; hidden from people and assistive technology. */}
            <div className="hidden" aria-hidden>
              <input name="website" tabIndex={-1} autoComplete="off" />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('privacy')}</p>
            {error && (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {error}
              </p>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                {t('submit')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
