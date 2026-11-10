import { loadTranslationItems, type TranslationScope } from '@tix/core';
import { getBaseContentLocale } from '@/server/admin/edit-locale';
import { saveTranslationsAction } from '@/server/admin/translations';
import { getCore } from '@/server/core';
import { TranslationPane } from './translation-pane';

/** Server wrapper: loads the texts of an event tab and renders the translation form. */
export async function EventTranslationPane({
  eventId,
  scope,
  editLocale,
}: {
  eventId: string;
  scope: TranslationScope;
  editLocale: string;
}) {
  const [groups, baseLocale] = await Promise.all([
    loadTranslationItems(getCore(), eventId, scope, editLocale),
    getBaseContentLocale(),
  ]);
  return (
    <TranslationPane
      action={saveTranslationsAction.bind(null, eventId, scope)}
      scope={scope}
      editLocale={editLocale}
      baseLocale={baseLocale}
      groups={groups}
    />
  );
}
