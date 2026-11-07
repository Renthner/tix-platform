import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '@tix/shared';
// Texts of generated documents (e-mail item lists, invoice PDFs) live with all other UI texts
// in the web app's message catalogue (namespace `mail`); bundlers inline the JSON.
import de from '../../../../apps/web/messages/de/mail.json';
import en from '../../../../apps/web/messages/en/mail.json';

type Messages = typeof en;

const CATALOGUE: Record<AppLocale, Messages> = { en, de };

/** Supported app locale for a requested BCP-47 tag (`de-AT` → `de`), else the default. */
export function documentLocale(requested: string | null | undefined): AppLocale {
  if (!requested) return DEFAULT_LOCALE;
  if (isAppLocale(requested)) return requested;
  const base = requested.split('-')[0] ?? '';
  return isAppLocale(base) ? base : DEFAULT_LOCALE;
}

export type MailTranslator = (
  key: string,
  params?: Record<string, string | number | null | undefined>,
) => string;

function lookup(messages: unknown, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Translator for the `mail` namespace. Supports simple `{name}` arguments (no ICU plural or
 * select – keep these messages simple). Missing keys fall back to English, then the key.
 */
export function mailTranslator(locale: string | null | undefined): MailTranslator {
  const messages = CATALOGUE[documentLocale(locale)];
  return (key, params) => {
    const template = lookup(messages, key) ?? lookup(CATALOGUE[DEFAULT_LOCALE], key) ?? key;
    if (!params) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
      const value = params[name];
      return value === undefined || value === null ? match : String(value);
    });
  };
}
