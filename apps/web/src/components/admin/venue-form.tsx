'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { IDLE, type ActionState } from '@/lib/action-state';
import { slugify } from '@/lib/slug';
import { ActionForm, ActionFeedback, Field, SubmitButton, errorOf } from './form-controls';

export interface VenueFormValues {
  name: string;
  slug: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string;
  websiteUrl: string | null;
  mapsUrl: string | null;
  description: string | null;
  isActive: boolean;
}

export function VenueForm({
  action,
  initial,
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  initial: VenueFormValues;
}) {
  const t = useTranslations('admin.venues.form');
  const tc = useTranslations('common.actions');
  const [state, formAction] = useActionState(action, IDLE);
  const [slug, setSlug] = useState(initial.slug);
  const [slugTouched, setSlugTouched] = useState(initial.slug !== '');
  const err = (name: string) => errorOf(state, name);

  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('name')} htmlFor="name" error={err('name')}>
          <Input
            id="name"
            name="name"
            defaultValue={initial.name}
            required
            maxLength={200}
            onChange={(e) => !slugTouched && setSlug(slugify(e.target.value))}
          />
        </Field>
        <Field label={t('slug')} htmlFor="slug" error={err('slug')} hint={t('slugHint')}>
          <Input
            id="slug"
            name="slug"
            value={slug}
            required
            maxLength={80}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Field>
        <Field label={t('street')} htmlFor="street" error={err('street')}>
          <Input id="street" name="street" defaultValue={initial.street ?? ''} maxLength={200} />
        </Field>
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Field label={t('postalCode')} htmlFor="postalCode" error={err('postalCode')}>
            <Input
              id="postalCode"
              name="postalCode"
              defaultValue={initial.postalCode ?? ''}
              maxLength={20}
            />
          </Field>
          <Field label={t('city')} htmlFor="city" error={err('city')}>
            <Input id="city" name="city" defaultValue={initial.city ?? ''} maxLength={120} />
          </Field>
        </div>
        <Field
          label={t('country')}
          htmlFor="country"
          error={err('country')}
          hint={t('countryHint')}
        >
          <Input
            id="country"
            name="country"
            defaultValue={initial.country ?? ''}
            maxLength={2}
            className="uppercase"
          />
        </Field>
        <Field
          label={t('timeZone')}
          htmlFor="timeZone"
          error={err('timeZone')}
          hint={t('timeZoneHint')}
        >
          <Input
            id="timeZone"
            name="timeZone"
            defaultValue={initial.timeZone}
            required
            list="tz-list"
          />
        </Field>
        <Field
          label={t('latitude')}
          htmlFor="latitude"
          error={err('latitude')}
          hint={t('coordinatesHint')}
        >
          <Input
            id="latitude"
            name="latitude"
            inputMode="decimal"
            defaultValue={initial.latitude ?? ''}
          />
        </Field>
        <Field label={t('longitude')} htmlFor="longitude" error={err('longitude')}>
          <Input
            id="longitude"
            name="longitude"
            inputMode="decimal"
            defaultValue={initial.longitude ?? ''}
          />
        </Field>
        <Field
          label={t('websiteUrl')}
          htmlFor="websiteUrl"
          error={err('websiteUrl')}
          className="md:col-span-2"
        >
          <Input
            id="websiteUrl"
            name="websiteUrl"
            type="url"
            defaultValue={initial.websiteUrl ?? ''}
          />
        </Field>
        <Field
          label={t('mapsUrl')}
          htmlFor="mapsUrl"
          error={err('mapsUrl')}
          hint={t('mapsUrlHint')}
          className="md:col-span-2"
        >
          <Input
            id="mapsUrl"
            name="mapsUrl"
            type="url"
            placeholder="https://maps.app.goo.gl/…"
            defaultValue={initial.mapsUrl ?? ''}
          />
        </Field>
        <Field
          label={t('description')}
          htmlFor="description"
          error={err('description')}
          className="md:col-span-2"
        >
          <Textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={initial.description ?? ''}
          />
        </Field>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <Switch name="isActive" defaultChecked={initial.isActive} />
        {t('isActive')}
      </label>
      <TimeZoneOptions />
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

/** IANA zone suggestions for time-zone inputs (browser-provided list). */
export function TimeZoneOptions() {
  const zones =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : ['UTC', 'Europe/Berlin'];
  return (
    <datalist id="tz-list">
      {zones.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}
