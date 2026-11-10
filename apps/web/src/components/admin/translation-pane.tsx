'use client';

import type { GlobalTranslationScope, TranslationGroupView, TranslationScope } from '@tix/core';
import { useLocale, useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { IDLE, type ActionState } from '@/lib/action-state';
import { ActionFeedback, ActionForm, SubmitButton } from './form-controls';
import { RichTextEditor } from './rich-text-editor';

type Action = (state: ActionState, fd: FormData) => Promise<ActionState>;

const MULTILINE = new Set(['message', 'description']);

/**
 * Translation view of an event tab: the base text (read-only) next to the input of the edited
 * language. Empty = falls back to the base text in the shop. The locale is a hidden field of the
 * form, so a save always goes to the language shown when the page was rendered.
 */
export function TranslationPane({
  action,
  scope,
  editLocale,
  baseLocale,
  groups,
}: {
  action: Action;
  scope: TranslationScope | GlobalTranslationScope;
  editLocale: string;
  baseLocale: string;
  groups: TranslationGroupView[];
}) {
  const t = useTranslations('translations');
  // Group / field keys come from the data (translations.groups.*, translations.fields.*).
  const tk = t as unknown as (key: string) => string;
  const uiLocale = useLocale();
  const [state, formAction] = useActionState(action, IDLE);
  const names = new Intl.DisplayNames([uiLocale], { type: 'language' });
  const language = names.of(editLocale) ?? editLocale;

  return (
    <ActionForm action={formAction} className="space-y-6">
      <ActionFeedback state={state} />
      <input type="hidden" name="locale" value={editLocale} />
      <Alert>
        <AlertDescription>
          {t('pane.intro', { language, base: names.of(baseLocale) ?? baseLocale })}
          <span className="block text-xs text-muted-foreground">
            {t(`pane.scopeHint.${scope}`)}
          </span>
        </AlertDescription>
      </Alert>
      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">{t(`pane.empty.${scope}`)}</p>
      )}
      {groups.map((group) => (
        <section key={group.key} className="space-y-3">
          <h2 className="text-base font-semibold">{tk(`groups.${group.key}`)}</h2>
          {group.readOnly && (
            <p className="text-sm text-muted-foreground">
              {t('pane.readOnlyGlobal')}{' '}
              <Link href="/admin/fees" className="underline">
                {t('pane.readOnlyLink')}
              </Link>
            </p>
          )}
          <div className="space-y-4">
            {group.items.map((item) => (
              <div key={`${item.entity}:${item.id}`} className="space-y-3 rounded-lg border p-4">
                {item.label && <p className="text-sm font-medium">{item.label}</p>}
                {group.readOnly &&
                  item.fields.map((field) => (
                    <p key={field.name} className="text-sm text-muted-foreground">
                      {language}: {field.value || '–'}
                    </p>
                  ))}
                {!group.readOnly &&
                  item.fields.map((field) => {
                    const inputName = `t:${item.entity}:${item.id}:${field.name}`;
                    const baseEmpty = field.base.trim() === '';
                    return (
                      <div key={field.name} className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <p className="text-xs font-medium text-muted-foreground">
                            {tk(`fields.${field.name}`)} · {t('pane.base')}
                          </p>
                          {field.rich ? (
                            <div
                              className="rich-text rounded-md border bg-muted/40 p-3 text-sm"
                              // Sanitised when saved.
                              dangerouslySetInnerHTML={{ __html: field.base }}
                            />
                          ) : (
                            <p className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
                              {field.base || '–'}
                            </p>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          <label
                            htmlFor={inputName}
                            className="text-xs font-medium text-muted-foreground"
                          >
                            {tk(`fields.${field.name}`)} · {language}
                          </label>
                          {field.rich ? (
                            <RichTextEditor
                              name={inputName}
                              id={inputName}
                              defaultValue={field.value}
                              ariaLabel={tk(`fields.${field.name}`)}
                              compact
                            />
                          ) : MULTILINE.has(field.name) ? (
                            <Textarea
                              id={inputName}
                              name={inputName}
                              defaultValue={field.value}
                              placeholder={field.base}
                              maxLength={field.max}
                              rows={3}
                              disabled={baseEmpty}
                            />
                          ) : (
                            <Input
                              id={inputName}
                              name={inputName}
                              defaultValue={field.value}
                              placeholder={field.base}
                              maxLength={field.max}
                              disabled={baseEmpty}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </section>
      ))}
      <SubmitButton>{t('pane.save')}</SubmitButton>
    </ActionForm>
  );
}
