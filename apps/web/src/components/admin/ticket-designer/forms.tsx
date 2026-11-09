'use client';

import { Copy, Pencil, Star, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  ActionFeedback,
  ActionForm,
  Field,
  NativeSelect,
  SubmitButton,
  errorOf,
} from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { IDLE, type ActionState } from '@/lib/action-state';
import {
  assignCategoryTemplatesAction,
  assignEventTemplateAction,
  createEventTemplateAction,
  createLibraryTemplateAction,
  deleteTicketTemplateAction,
  duplicateTicketTemplateAction,
  setDefaultTicketTemplateAction,
} from '@/server/admin/ticket-templates';

export interface TemplateOption {
  id: string;
  name: string;
  /** Event-owned (true) or library template. */
  eventOwned: boolean;
}

function useToastOnSuccess(state: ActionState, message: string) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === 'success' && state.at !== last.current) {
      last.current = state.at;
      toast.success(message);
    }
  }, [state, message]);
}

/** Row actions of the template list. */
export function TemplateRowActions({
  id,
  isDefault,
  global,
}: {
  id: string;
  isDefault: boolean;
  global: boolean;
}) {
  const t = useTranslations('ticketDesigner.page.actions');
  const tMsg = useTranslations('admin.messages');
  const [dup, dupAction] = useActionState(duplicateTicketTemplateAction.bind(null, id), IDLE);
  const [del, delAction] = useActionState(deleteTicketTemplateAction.bind(null, id), IDLE);
  const [def, defAction] = useActionState(setDefaultTicketTemplateAction.bind(null, id), IDLE);
  useToastOnSuccess(dup, tMsg('created'));
  useToastOnSuccess(del, tMsg('deleted'));
  useToastOnSuccess(def, tMsg('saved'));
  const failed = [dup, del, def].find((s) => s.status === 'error');
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button asChild variant="outline" size="sm">
        <Link href={`/admin/ticket-templates/${id}`}>
          <Pencil className="size-4" />
          {t('edit')}
        </Link>
      </Button>
      <ActionForm action={dupAction}>
        <SubmitButton variant="ghost" size="sm" pendingLabel={t('duplicate')}>
          <Copy className="size-4" />
          {t('duplicate')}
        </SubmitButton>
      </ActionForm>
      {global && !isDefault && (
        <ActionForm action={defAction}>
          <SubmitButton variant="ghost" size="sm" pendingLabel={t('setDefault')}>
            <Star className="size-4" />
            {t('setDefault')}
          </SubmitButton>
        </ActionForm>
      )}
      {!isDefault && (
        <ActionForm
          action={delAction}
          onSubmitCapture={(e) => {
            if (!window.confirm(t('confirmDelete'))) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          <SubmitButton variant="ghost" size="sm" pendingLabel={t('delete')}>
            <Trash2 className="size-4" />
            {t('delete')}
          </SubmitButton>
        </ActionForm>
      )}
      {failed && <ActionFeedback state={failed} />}
    </div>
  );
}

function TemplateSelect({
  id,
  name,
  value,
  options,
  firstLabel,
  groupLabels,
}: {
  id?: string;
  name: string;
  value: string;
  options: TemplateOption[];
  firstLabel: string;
  groupLabels: { library: string; event: string };
}) {
  const library = options.filter((o) => !o.eventOwned);
  const own = options.filter((o) => o.eventOwned);
  const render = (list: TemplateOption[]) =>
    list.map((o) => (
      <option key={o.id} value={o.id}>
        {o.name}
      </option>
    ));
  return (
    <NativeSelect id={id} name={name} defaultValue={value}>
      <option value="">{firstLabel}</option>
      {own.length > 0 &&
        (groupLabels.event ? (
          <optgroup label={groupLabels.event}>{render(own)}</optgroup>
        ) : (
          render(own)
        ))}
      {library.length > 0 &&
        (groupLabels.library ? (
          <optgroup label={groupLabels.library}>{render(library)}</optgroup>
        ) : (
          render(library)
        ))}
    </NativeSelect>
  );
}

export function CreateLibraryTemplateForm({ options }: { options: TemplateOption[] }) {
  const t = useTranslations('ticketDesigner.page.create');
  const [state, action] = useActionState(createLibraryTemplateAction, IDLE);
  return (
    <ActionForm action={action} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <Field label={t('name')} htmlFor="tpl-name" error={errorOf(state, 'name')}>
        <Input id="tpl-name" name="name" maxLength={120} required />
      </Field>
      <Field label={t('basedOn')} htmlFor="tpl-based">
        <TemplateSelect
          id="tpl-based"
          name="basedOn"
          value=""
          options={options}
          firstLabel={t('blank')}
          groupLabels={{ library: '', event: '' }}
        />
      </Field>
      <SubmitButton>{t('submit')}</SubmitButton>
      <div className="sm:col-span-3">
        <ActionFeedback state={state} />
      </div>
    </ActionForm>
  );
}

export function EventTemplateAssignment({
  eventId,
  eventTemplateId,
  options,
}: {
  eventId: string;
  eventTemplateId: string | null;
  options: TemplateOption[];
}) {
  const t = useTranslations('ticketDesigner.eventTab');
  const tMsg = useTranslations('admin.messages');
  const [state, action] = useActionState(assignEventTemplateAction.bind(null, eventId), IDLE);
  useToastOnSuccess(state, tMsg('saved'));
  return (
    <ActionForm action={action} className="flex flex-wrap items-end gap-3">
      <Field label={t('eventDesign')} htmlFor="evt-template" className="min-w-72">
        <TemplateSelect
          id="evt-template"
          name="templateId"
          value={eventTemplateId ?? ''}
          options={options}
          firstLabel={t('globalDefault')}
          groupLabels={{ library: t('libraryGroup'), event: t('eventGroup') }}
        />
      </Field>
      <SubmitButton>{t('saveAssignments')}</SubmitButton>
      <ActionFeedback state={state} />
    </ActionForm>
  );
}

export function CategoryTemplateAssignment({
  eventId,
  categories,
  options,
}: {
  eventId: string;
  categories: { id: string; name: string; templateId: string | null }[];
  options: TemplateOption[];
}) {
  const t = useTranslations('ticketDesigner.eventTab');
  const tMsg = useTranslations('admin.messages');
  const [state, action] = useActionState(
    assignCategoryTemplatesAction.bind(
      null,
      eventId,
      categories.map((c) => c.id),
    ),
    IDLE,
  );
  useToastOnSuccess(state, tMsg('saved'));
  return (
    <ActionForm action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {categories.map((c) => (
          <Field key={c.id} label={c.name} htmlFor={`cat-${c.id}`}>
            <TemplateSelect
              id={`cat-${c.id}`}
              name={`cat:${c.id}`}
              value={c.templateId ?? ''}
              options={options}
              firstLabel={t('inherit')}
              groupLabels={{ library: t('libraryGroup'), event: t('eventGroup') }}
            />
          </Field>
        ))}
      </div>
      <SubmitButton>{t('saveAssignments')}</SubmitButton>
      <ActionFeedback state={state} />
    </ActionForm>
  );
}

export function CreateEventTemplateForm({
  eventId,
  options,
  categories,
}: {
  eventId: string;
  options: TemplateOption[];
  categories: { id: string; name: string }[];
}) {
  const t = useTranslations('ticketDesigner.eventTab.customize');
  const [state, action] = useActionState(createEventTemplateAction.bind(null, eventId), IDLE);
  return (
    <ActionForm action={action} className="grid gap-4 sm:grid-cols-2">
      <Field label={t('name')} htmlFor="evt-tpl-name" error={errorOf(state, 'name')}>
        <Input id="evt-tpl-name" name="name" maxLength={120} required />
      </Field>
      <Field label={t('basedOn')} htmlFor="evt-tpl-based">
        <TemplateSelect
          id="evt-tpl-based"
          name="basedOn"
          value=""
          options={options}
          firstLabel={t('blank')}
          groupLabels={{ library: '', event: '' }}
        />
      </Field>
      <Field label={t('assignTo')} htmlFor="evt-tpl-assign" error={errorOf(state, 'assignTo')}>
        <NativeSelect id="evt-tpl-assign" name="assignTo" defaultValue="event">
          <option value="event">{t('assignEvent')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {t('assignCategory', { name: c.name })}
            </option>
          ))}
          <option value="none">{t('assignNone')}</option>
        </NativeSelect>
      </Field>
      <div className="flex items-end">
        <SubmitButton>{t('submit')}</SubmitButton>
      </div>
      <div className="sm:col-span-2">
        <ActionFeedback state={state} />
      </div>
    </ActionForm>
  );
}
