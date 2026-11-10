import {
  globalTranslationCompleteness,
  loadGlobalTranslationItems,
  type GlobalTranslationScope,
} from '@tix/core';
import { getBaseContentLocale, getEditLocale } from '@/server/admin/edit-locale';
import { saveGlobalTranslationsAction } from '@/server/admin/translations';
import { getCore } from '@/server/core';
import { EditLocaleSwitcher } from './edit-locale-switcher';
import { TranslationPane } from './translation-pane';

/** Content language dropdown for a global admin page (header actions). */
export async function GlobalLocaleSwitcher({ scope }: { scope: GlobalTranslationScope }) {
  const [baseLocale, editLocale, completeness] = await Promise.all([
    getBaseContentLocale(),
    getEditLocale(),
    globalTranslationCompleteness(getCore(), scope),
  ]);
  return (
    <EditLocaleSwitcher
      baseLocale={baseLocale}
      current={editLocale ?? baseLocale}
      options={Object.entries(completeness).map(([locale, c]) => ({ locale, ...c }))}
    />
  );
}

/** Translation form of global texts in the given language. */
export async function GlobalTranslationPane({
  scope,
  editLocale,
}: {
  scope: GlobalTranslationScope;
  editLocale: string;
}) {
  const [groups, baseLocale] = await Promise.all([
    loadGlobalTranslationItems(getCore(), scope, editLocale),
    getBaseContentLocale(),
  ]);
  return (
    <TranslationPane
      action={saveGlobalTranslationsAction.bind(null, scope)}
      scope={scope}
      editLocale={editLocale}
      baseLocale={baseLocale}
      groups={groups}
    />
  );
}
