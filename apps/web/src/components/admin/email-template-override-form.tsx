'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  ActionFeedback,
  ActionForm,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from './form-controls';

/** Creates an event override of the template (starts as a copy of the global text). */
export function EmailTemplateOverrideForm({
  action,
  events,
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  events: { id: string; title: string }[];
}) {
  const t = useTranslations('emailTemplates.page');
  const [state, formAction] = useActionState(action, IDLE);
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noEvents')}</p>;
  }
  return (
    <ActionForm action={formAction} className="flex flex-wrap items-end gap-3">
      <ActionFeedback state={state} />
      <Field label={t('chooseEvent')} htmlFor="override-event" error={errorOf(state, 'eventId')}>
        <NativeSelect
          id="override-event"
          name="eventId"
          defaultValue=""
          required
          className="min-w-64"
        >
          <option value="" disabled>
            {t('chooseEvent')}
          </option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <SubmitButton variant="outline">{t('createOverride')}</SubmitButton>
    </ActionForm>
  );
}
