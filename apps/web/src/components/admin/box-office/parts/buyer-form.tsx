'use client';

import { SUPPORTED_LOCALES } from '@tix/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { COUNTRIES } from '@/components/shop/checkout-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { useFieldErrors } from '@/lib/field-errors';
import { FieldMessage } from './primitives';
import type { BuyerState } from './types';

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20';

export function BuyerForm({
  buyer,
  setBuyer,
  buyerLocale,
  setBuyerLocale,
  fe,
}: {
  buyer: BuyerState;
  setBuyer: Dispatch<SetStateAction<BuyerState>>;
  buyerLocale: string;
  setBuyerLocale: (locale: string) => void;
  fe: ReturnType<typeof useFieldErrors>;
}) {
  const t = useTranslations('orders.boxOffice');
  const tErrAddress = useTranslations('checkout.address');
  const locale = useLocale();
  const languageNames = useMemo(
    () => new Intl.DisplayNames([locale], { type: 'language' }),
    [locale],
  );
  const regionNames = useMemo(() => new Intl.DisplayNames([locale], { type: 'region' }), [locale]);

  return (
    <div className="space-y-2" onChange={fe.onFormChange}>
      <div className="grid grid-cols-2 gap-2">
        {(['firstName', 'lastName'] as const).map((k) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`bo-${k}`}>{t(`buyer.${k}`)}</Label>
            <Input
              id={`bo-${k}`}
              aria-invalid={fe.invalid(`bo-${k}`)}
              value={buyer[k]}
              maxLength={100}
              onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
            />
            <FieldMessage message={fe.message(`bo-${k}`)} />
          </div>
        ))}
      </div>
      {(['email', 'phone', 'company'] as const).map((k) => (
        <div key={k} className="space-y-1">
          <Label htmlFor={`bo-${k}`}>{t(`buyer.${k}`)}</Label>
          <Input
            id={`bo-${k}`}
            aria-invalid={fe.invalid(`bo-${k}`)}
            type={k === 'email' ? 'email' : 'text'}
            value={buyer[k]}
            maxLength={k === 'email' ? 254 : 200}
            onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
          />
          <FieldMessage message={fe.message(`bo-${k}`)} />
        </div>
      ))}
      <div className="space-y-1">
        <Label htmlFor="bo-language">{t('buyer.language')}</Label>
        <select
          id="bo-language"
          aria-invalid={fe.invalid('bo-language')}
          className={SELECT_CLASS}
          value={buyerLocale}
          onChange={(e) => setBuyerLocale(e.target.value)}
        >
          {SUPPORTED_LOCALES.map((code) => (
            <option key={code} value={code}>
              {languageNames.of(code) ?? code}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2 rounded-md border p-2">
        <div className="text-sm font-medium">{t('buyer.address')}</div>
        {(
          [
            ['street', tErrAddress('street')],
            ['addressLine2', tErrAddress('line2')],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`bo-${k}`}>{label}</Label>
            <Input
              id={`bo-${k}`}
              aria-invalid={fe.invalid(`bo-${k}`)}
              value={buyer[k]}
              maxLength={200}
              onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
            />
            <FieldMessage message={fe.message(`bo-${k}`)} />
          </div>
        ))}
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          {(
            [
              ['postalCode', tErrAddress('postalCode')],
              ['city', tErrAddress('city')],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={`bo-${k}`}>{label}</Label>
              <Input
                id={`bo-${k}`}
                aria-invalid={fe.invalid(`bo-${k}`)}
                value={buyer[k]}
                maxLength={k === 'postalCode' ? 20 : 120}
                onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
              />
              <FieldMessage message={fe.message(`bo-${k}`)} />
            </div>
          ))}
        </div>
        <div className="space-y-1">
          <Label htmlFor="bo-country">{tErrAddress('country')}</Label>
          <select
            id="bo-country"
            aria-invalid={fe.invalid('bo-country')}
            className={SELECT_CLASS}
            value={buyer.country}
            onChange={(e) => setBuyer((b) => ({ ...b, country: e.target.value }))}
          >
            {COUNTRIES.map((code) => (
              <option key={code} value={code}>
                {regionNames.of(code) ?? code}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="bo-note">{t('buyer.note')}</Label>
        <Textarea
          id="bo-note"
          aria-invalid={fe.invalid('bo-note')}
          rows={2}
          maxLength={1000}
          value={buyer.note}
          onChange={(e) => setBuyer((b) => ({ ...b, note: e.target.value }))}
        />
      </div>
    </div>
  );
}
