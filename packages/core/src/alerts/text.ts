import type { AdminAlertType } from '@tix/shared';
import { formatDateTime } from '../format';
import { mailTranslator } from '../i18n/mail-messages';
import type { AlertDetails } from './checks';

/*
 * Alert texts live in their own small module (no database, backup or engine imports) so the
 * backup runtime can use them with a plain static import. A dynamic `import('../alerts/engine')`
 * there made esbuild wrap the engine and everything only it reaches in lazy `__esm` initialisers;
 * the worker's `export *` path never ran them, so module constants stayed undefined in production.
 */

export interface AlertText {
  title: string;
  summary: string;
}

/** Title and one-paragraph summary of an alert in the given language (texts: `mail.json` → `alerts`). */
export function alertText(
  type: AdminAlertType,
  details: AlertDetails,
  locale: string,
  timeZone: string,
): AlertText {
  const t = mailTranslator(locale);
  const variant = typeof details.variant === 'string' ? details.variant : 'default';
  const params: Record<string, string | number | null> = { ...details };
  if (typeof details.lastBackup === 'string') {
    params.lastBackup = formatDateTime(new Date(details.lastBackup), locale, timeZone, 'long');
  }
  for (const [name, value] of Object.entries(params)) if (value === null) params[name] = '–';
  return {
    title: t(`alerts.${type}.${variant}.title`, params),
    summary: t(`alerts.${type}.${variant}.summary`, params),
  };
}
