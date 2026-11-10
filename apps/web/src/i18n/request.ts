import { getSetting } from '@tix/core';
import { defaultSetting } from '@tix/shared';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { getCore } from '@/server/core';
import { MESSAGE_NAMESPACES } from './namespaces';
import { routing } from './routing';

/** Used when the settings cannot be read (e.g. static prerender during the Docker build). */
const FALLBACK_TIME_ZONE = defaultSetting('general').defaultTimeZone;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const entries = await Promise.all(
    MESSAGE_NAMESPACES.map(
      async (ns) => [ns, (await import(`../../messages/${locale}/${ns}.json`)).default] as const,
    ),
  );
  // Dates without an explicit zone (`format.dateTime(...)`, server AND client components) use
  // the shop time zone – never the container's TZ (UTC) or the visitor's browser zone.
  const timeZone = await (async () =>
    (await getSetting(getCore(), 'general')).defaultTimeZone)().catch(() => FALLBACK_TIME_ZONE);
  return { locale, messages: Object.fromEntries(entries), timeZone };
});
