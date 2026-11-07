'use client';

import { EVENT_STATUSES, type EventStatus } from '@tix/shared';
import { Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { IDLE, type ActionState } from '@/lib/action-state';
import { slugify } from '@/lib/slug';
import { RichTextEditor } from './rich-text-editor';
import { cn } from '@/lib/utils';
import {
  ActionForm,
  ActionFeedback,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';
import { TimeZoneOptions } from './venue-form';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

interface TaxRateOption {
  id: string;
  name: string;
  isDefault: boolean;
}

// ─── Create ─────────────────────────────────────────────────────────────────

export function EventCreateForm({
  action,
  venues,
  templates,
  taxRates,
  defaults,
}: {
  action: Action;
  venues: { id: string; name: string; timeZone: string }[];
  templates: { id: string; name: string; venueId: string }[];
  taxRates: TaxRateOption[];
  defaults: { timeZone: string; currency: string; orphanSeatRuleEnabled: boolean };
}) {
  const t = useTranslations('admin.events');
  const [state, formAction] = useActionState(action, IDLE);
  const [venueId, setVenueId] = useState(venues[0]?.id ?? '');
  const [timeZone, setTimeZone] = useState(venues[0]?.timeZone ?? defaults.timeZone);
  const [tzTouched, setTzTouched] = useState(false);
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const venueTemplates = useMemo(
    () => templates.filter((tpl) => tpl.venueId === venueId),
    [templates, venueId],
  );
  const err = (name: string) => errorOf(state, name);

  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('fields.title')} htmlFor="title" error={err('title')}>
          <Input
            id="title"
            name="title"
            required
            maxLength={200}
            onChange={(e) => !slugTouched && setSlug(slugify(e.target.value))}
          />
        </Field>
        <Field
          label={t('fields.slug')}
          htmlFor="slug"
          error={err('slug')}
          hint={t('fields.slugHint')}
        >
          <Input
            id="slug"
            name="slug"
            required
            maxLength={80}
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Field>
        <Field
          label={t('fields.subtitle')}
          htmlFor="subtitle"
          error={err('subtitle')}
          className="md:col-span-2"
        >
          <Input id="subtitle" name="subtitle" maxLength={300} />
        </Field>
        <Field label={t('fields.venue')} htmlFor="venueId" error={err('venueId')}>
          <NativeSelect
            id="venueId"
            name="venueId"
            required
            value={venueId}
            onChange={(e) => {
              setVenueId(e.target.value);
              const venue = venues.find((v) => v.id === e.target.value);
              if (venue && !tzTouched) setTimeZone(venue.timeZone);
            }}
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label={t('fields.template')}
          htmlFor="templateId"
          error={err('templateId')}
          hint={t('fields.templateHint')}
        >
          <NativeSelect
            id="templateId"
            name="templateId"
            key={venueId}
            defaultValue={venueTemplates[0]?.id ?? ''}
          >
            {venueTemplates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}
              </option>
            ))}
            <option value="">{t('fields.emptyPlan')}</option>
          </NativeSelect>
        </Field>
        <Field
          label={t('fields.startsAt')}
          htmlFor="startsAt"
          error={err('startsAt')}
          hint={t('fields.timesHint')}
        >
          <Input id="startsAt" name="startsAt" type="datetime-local" required />
        </Field>
        <Field label={t('fields.timeZone')} htmlFor="timeZone" error={err('timeZone')}>
          <Input
            id="timeZone"
            name="timeZone"
            list="tz-list"
            required
            value={timeZone}
            onChange={(e) => {
              setTzTouched(true);
              setTimeZone(e.target.value);
            }}
          />
        </Field>
        <Field label={t('fields.doorsOpenAt')} htmlFor="doorsOpenAt" error={err('doorsOpenAt')}>
          <Input id="doorsOpenAt" name="doorsOpenAt" type="datetime-local" />
        </Field>
        <Field label={t('fields.endsAt')} htmlFor="endsAt" error={err('endsAt')}>
          <Input id="endsAt" name="endsAt" type="datetime-local" />
        </Field>
        <Field label={t('fields.currency')} htmlFor="currency" error={err('currency')}>
          <Input
            id="currency"
            name="currency"
            defaultValue={defaults.currency}
            maxLength={3}
            required
            className="uppercase"
          />
        </Field>
        <Field label={t('fields.taxRate')} htmlFor="taxRateId" error={err('taxRateId')}>
          <NativeSelect
            id="taxRateId"
            name="taxRateId"
            defaultValue={taxRates.find((r) => r.isDefault)?.id ?? taxRates[0]?.id}
          >
            {taxRates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label={t('fields.description')} htmlFor="description" error={err('description')}>
        <RichTextEditor
          id="description"
          name="description"
          defaultValue=""
          ariaLabel={t('fields.description')}
          invalid={Boolean(err('description'))}
        />
      </Field>
      <OrphanRuleSwitch defaultChecked={defaults.orphanSeatRuleEnabled} />
      <TimeZoneOptions />
      <SubmitButton>{t('create.submit')}</SubmitButton>
    </ActionForm>
  );
}

function OrphanRuleSwitch({ defaultChecked }: { defaultChecked: boolean }) {
  const t = useTranslations('admin.events.fields');
  return (
    <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
      <Switch name="orphanSeatRuleEnabled" defaultChecked={defaultChecked} className="mt-0.5" />
      <span>
        <span className="font-medium">{t('orphanSeatRule')}</span>
        <span className="block text-muted-foreground">{t('orphanSeatRuleHint')}</span>
      </span>
    </label>
  );
}

// ─── Details ────────────────────────────────────────────────────────────────

export interface EventDetailsValues {
  title: string;
  subtitle: string | null;
  description: string | null;
  slug: string;
  startsAt: string;
  endsAt: string;
  doorsOpenAt: string;
  timeZone: string;
  currency: string;
  taxRateId: string;
}

export function EventDetailsForm({
  action,
  initial,
  taxRates,
}: {
  action: Action;
  initial: EventDetailsValues;
  taxRates: TaxRateOption[];
}) {
  const t = useTranslations('admin.events');
  const tc = useTranslations('common.actions');
  const [state, formAction] = useActionState(action, IDLE);
  const err = (name: string) => errorOf(state, name);
  return (
    <ActionForm action={formAction} className="space-y-5">
      <ActionFeedback state={state} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('fields.title')} htmlFor="title" error={err('title')}>
          <Input id="title" name="title" defaultValue={initial.title} required maxLength={200} />
        </Field>
        <Field
          label={t('fields.slug')}
          htmlFor="slug"
          error={err('slug')}
          hint={t('fields.slugHint')}
        >
          <Input id="slug" name="slug" defaultValue={initial.slug} required maxLength={80} />
        </Field>
        <Field
          label={t('fields.subtitle')}
          htmlFor="subtitle"
          error={err('subtitle')}
          className="md:col-span-2"
        >
          <Input
            id="subtitle"
            name="subtitle"
            defaultValue={initial.subtitle ?? ''}
            maxLength={300}
          />
        </Field>
        <Field
          label={t('fields.description')}
          htmlFor="description"
          error={err('description')}
          className="md:col-span-2"
        >
          <RichTextEditor
            id="description"
            name="description"
            defaultValue={initial.description ?? ''}
            ariaLabel={t('fields.description')}
            invalid={Boolean(err('description'))}
          />
        </Field>
        <Field
          label={t('fields.startsAt')}
          htmlFor="startsAt"
          error={err('startsAt')}
          hint={t('fields.timesHint')}
        >
          <Input
            id="startsAt"
            name="startsAt"
            type="datetime-local"
            defaultValue={initial.startsAt}
            required
          />
        </Field>
        <Field label={t('fields.timeZone')} htmlFor="timeZone" error={err('timeZone')}>
          <Input
            id="timeZone"
            name="timeZone"
            list="tz-list"
            defaultValue={initial.timeZone}
            required
          />
        </Field>
        <Field label={t('fields.doorsOpenAt')} htmlFor="doorsOpenAt" error={err('doorsOpenAt')}>
          <Input
            id="doorsOpenAt"
            name="doorsOpenAt"
            type="datetime-local"
            defaultValue={initial.doorsOpenAt}
          />
        </Field>
        <Field label={t('fields.endsAt')} htmlFor="endsAt" error={err('endsAt')}>
          <Input id="endsAt" name="endsAt" type="datetime-local" defaultValue={initial.endsAt} />
        </Field>
        <Field label={t('fields.currency')} htmlFor="currency" error={err('currency')}>
          <Input
            id="currency"
            name="currency"
            defaultValue={initial.currency}
            maxLength={3}
            required
            className="uppercase"
          />
        </Field>
        <Field label={t('fields.taxRate')} htmlFor="taxRateId" error={err('taxRateId')}>
          <NativeSelect id="taxRateId" name="taxRateId" defaultValue={initial.taxRateId}>
            {taxRates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <TimeZoneOptions />
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Status / publishing ────────────────────────────────────────────────────

export function EventStatusForm({
  action,
  status,
  checklist,
}: {
  action: Action;
  status: EventStatus;
  checklist: { seatMap: boolean; category: boolean; tariff: boolean; inventory: boolean };
}) {
  const t = useTranslations('admin.events.publish');
  const ts = useTranslations('admin.eventStatus');
  const [state, formAction] = useActionState(action, IDLE);
  const [next, setNext] = useState<EventStatus>(status);
  return (
    <ActionForm action={formAction} className="space-y-4">
      <ActionFeedback state={state} />
      <ul className="space-y-1.5 text-sm">
        {(Object.keys(checklist) as (keyof typeof checklist)[]).map((key) => (
          <li
            key={key}
            className={cn('flex items-center gap-2', !checklist[key] && 'text-destructive')}
          >
            {checklist[key] ? (
              <Check className="size-4 text-emerald-600" />
            ) : (
              <X className="size-4" />
            )}
            {t(`checklist.${key}`)}
          </li>
        ))}
      </ul>
      <Field label={t('status')} htmlFor="status" error={errorOf(state, 'status')}>
        <NativeSelect
          id="status"
          name="status"
          value={next}
          onChange={(e) => setNext(e.target.value as EventStatus)}
        >
          {EVENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ts(s)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {next === 'CANCELLED' && (
        <Field label={t('cancellationReason')} htmlFor="cancellationReason">
          <Textarea id="cancellationReason" name="cancellationReason" rows={2} maxLength={1000} />
        </Field>
      )}
      <SubmitButton>{t('apply')}</SubmitButton>
    </ActionForm>
  );
}

// ─── Sales ──────────────────────────────────────────────────────────────────

export interface EventSalesValues {
  presaleStartsAt: string;
  publicSaleStartsAt: string;
  saleEndsAt: string;
  salesPaused: boolean;
  maxTicketsPerOrder: number | null;
  maxTicketsPerCustomer: number | null;
  cartLockTtlSeconds: number | null;
  paymentGraceSeconds: number | null;
  manualSeatSelectionEnabled: boolean | null;
  bestAvailableEnabled: boolean | null;
  orphanSeatRuleEnabled: boolean;
  companionRequiresWheelchair: boolean | null;
  paypalEnabled: boolean | null;
  bankTransferEnabled: boolean | null;
  bankTransferPaymentTermDays: number | null;
  bankTransferReminderAfterDays: number | null;
  bankTransferCancelAfterDays: number | null;
  bankTransferDisableDaysBeforeEvent: number | null;
  /** false = no sign-in / registration in the checkout of this event; null = global. */
  customerAccountsEnabled: boolean | null;
}

export interface GlobalCheckoutDefaults {
  /** Null = unlimited. */
  maxTicketsPerOrder: number | null;
  maxTicketsPerCustomer: number | null;
  cartLockTtlSeconds: number;
  paymentGraceSeconds: number;
  manualSeatSelectionEnabled: boolean;
  bestAvailableEnabled: boolean;
  companionRequiresWheelchair: boolean;
  paypalEnabled: boolean;
  bankTransferEnabled: boolean;
  bankTransferPaymentTermDays: number;
  bankTransferReminderAfterDays: number;
  bankTransferCancelAfterDays: number;
  bankTransferDisableDaysBeforeEvent: number;
  customerAccountsEnabled: boolean;
}

export function EventSalesForm({
  action,
  initial,
  globals,
  timeZone,
}: {
  action: Action;
  initial: EventSalesValues;
  globals: GlobalCheckoutDefaults;
  timeZone: string;
}) {
  const t = useTranslations('admin.events.sales');
  const tf = useTranslations('admin.events.fields');
  const tcm = useTranslations('admin.common');
  const tc = useTranslations('common.actions');
  const tp = useTranslations('orders.eventPayments');
  const [state, formAction] = useActionState(action, IDLE);
  const err = (name: string) => errorOf(state, name);
  const inherit = (value: string | number | null) =>
    tcm('inherit', { value: value === null ? tcm('unlimited') : String(value) });
  const onOff = (v: boolean) => (v ? tcm('on') : tcm('off'));

  const numberField = (
    name: keyof GlobalCheckoutDefaults & keyof EventSalesValues,
    min: number,
    max: number,
    label: string = t(name as never),
  ) => (
    <Field
      label={label}
      htmlFor={name}
      error={err(name)}
      hint={inherit(globals[name] as number | null)}
    >
      <Input
        id={name}
        name={name}
        type="number"
        min={min}
        max={max}
        defaultValue={(initial[name] as number | null) ?? ''}
        placeholder={String(globals[name] ?? '')}
      />
    </Field>
  );

  const triField = (
    name:
      | 'manualSeatSelectionEnabled'
      | 'bestAvailableEnabled'
      | 'companionRequiresWheelchair'
      | 'paypalEnabled'
      | 'bankTransferEnabled',
    label: string = t(name as never),
  ) => (
    <Field label={label} htmlFor={name}>
      <NativeSelect
        id={name}
        name={name}
        defaultValue={initial[name] === null ? 'inherit' : initial[name] ? 'on' : 'off'}
      >
        <option value="inherit">{inherit(onOff(globals[name]))}</option>
        <option value="on">{tcm('on')}</option>
        <option value="off">{tcm('off')}</option>
      </NativeSelect>
    </Field>
  );

  return (
    <ActionForm action={formAction} className="space-y-6">
      <ActionFeedback state={state} />
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('windows')}</h3>
        <p className="text-xs text-muted-foreground">{t('windowsHint', { timeZone })}</p>
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            label={t('presaleStartsAt')}
            htmlFor="presaleStartsAt"
            error={err('presaleStartsAt')}
          >
            <Input
              id="presaleStartsAt"
              name="presaleStartsAt"
              type="datetime-local"
              defaultValue={initial.presaleStartsAt}
            />
          </Field>
          <Field
            label={t('publicSaleStartsAt')}
            htmlFor="publicSaleStartsAt"
            error={err('publicSaleStartsAt')}
          >
            <Input
              id="publicSaleStartsAt"
              name="publicSaleStartsAt"
              type="datetime-local"
              defaultValue={initial.publicSaleStartsAt}
            />
          </Field>
          <Field
            label={t('saleEndsAt')}
            htmlFor="saleEndsAt"
            error={err('saleEndsAt')}
            hint={t('saleEndsAtHint')}
          >
            <Input
              id="saleEndsAt"
              name="saleEndsAt"
              type="datetime-local"
              defaultValue={initial.saleEndsAt}
            />
          </Field>
        </div>
        <label className="flex items-center gap-3 text-sm">
          <Switch name="salesPaused" defaultChecked={initial.salesPaused} />
          <span>
            <span className="font-medium">{t('salesPaused')}</span>
            <span className="block text-xs text-muted-foreground">{t('salesPausedHint')}</span>
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('limits')}</h3>
        <p className="text-xs text-muted-foreground">{t('limitsHint')}</p>
        <div className="grid gap-4 md:grid-cols-2">
          {numberField('maxTicketsPerOrder', 1, 10000)}
          {numberField('maxTicketsPerCustomer', 1, 10000)}
          {numberField('cartLockTtlSeconds', 60, 3600)}
          {numberField('paymentGraceSeconds', 0, 3600)}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('selection')}</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {triField('manualSeatSelectionEnabled')}
          {triField('bestAvailableEnabled')}
          {triField('companionRequiresWheelchair')}
        </div>
        <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
          <Switch
            name="orphanSeatRuleEnabled"
            defaultChecked={initial.orphanSeatRuleEnabled}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">{tf('orphanSeatRule')}</span>
            <span className="block text-muted-foreground">{tf('orphanSeatRuleHint')}</span>
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{tp('title')}</h3>
        <p className="text-xs text-muted-foreground">{tp('hint')}</p>
        <div className="grid gap-4 md:grid-cols-2">
          {triField('paypalEnabled', tp('paypalEnabled'))}
          {triField('bankTransferEnabled', tp('bankTransferEnabled'))}
          {numberField('bankTransferPaymentTermDays', 1, 60, tp('paymentTermDays'))}
          {numberField('bankTransferReminderAfterDays', 1, 60, tp('reminderAfterDays'))}
          {numberField('bankTransferCancelAfterDays', 1, 90, tp('cancelAfterDays'))}
          {numberField('bankTransferDisableDaysBeforeEvent', 0, 90, tp('disableDaysBeforeEvent'))}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('accounts')}</h3>
        <p className="text-xs text-muted-foreground">{t('accountsHint')}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('customerAccountsEnabled')} htmlFor="customerAccountsEnabled">
            <NativeSelect
              id="customerAccountsEnabled"
              name="customerAccountsEnabled"
              defaultValue={initial.customerAccountsEnabled === false ? 'off' : 'inherit'}
            >
              <option value="inherit">
                {inherit(
                  globals.customerAccountsEnabled ? t('accountsShown') : t('accountsHidden'),
                )}
              </option>
              <option value="off">{t('accountsHideForEvent')}</option>
            </NativeSelect>
          </Field>
        </div>
      </section>
      <SubmitButton>{tc('save')}</SubmitButton>
    </ActionForm>
  );
}
