import { getSetting } from '@tix/core';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { resolveLocale } from '@/i18n/locale';
import { COOKIE_INVENTORY, type CookieInfo } from '@/lib/cookie-inventory';
import { getCore } from '@/server/core';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shop.cookies');
  return { title: t('title') };
}

export default async function CookiesPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const [t, tLayout, branding] = await Promise.all([
    getTranslations('shop.cookies'),
    getTranslations('shop.layout'),
    getSetting(getCore(), 'branding'),
  ]);

  const table = (cookies: readonly CookieInfo[], testId: string) => (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full table-fixed text-left text-sm" data-testid={testId}>
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="w-[34%] px-3 py-2 font-medium">{t('columns.name')}</th>
            <th className="px-3 py-2 font-medium">{t('columns.purpose')}</th>
            <th className="w-[26%] px-3 py-2 font-medium">{t('columns.lifetime')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {cookies.map((c) => (
            <tr key={c.key} className="align-top">
              <td className="px-3 py-2 font-mono text-xs break-all">{c.name}</td>
              <td className="px-3 py-2">{t(`items.${c.key}.purpose`)}</td>
              <td className="px-3 py-2">{t(`items.${c.key}.lifetime`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p>{t('intro')}</p>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('shopHeading')}</h2>
        {table(
          COOKIE_INVENTORY.filter((c) => c.scope === 'shop'),
          'cookies-shop',
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('staffHeading')}</h2>
        <p className="text-sm text-muted-foreground">{t('staffIntro')}</p>
        {table(
          COOKIE_INVENTORY.filter((c) => c.scope === 'staff'),
          'cookies-staff',
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('ipHeading')}</h2>
        <p>{t('ip')}</p>
        {branding.privacyUrl && (
          <p>
            {t('privacy')}{' '}
            <a href={branding.privacyUrl} className="underline underline-offset-2" rel="noopener">
              {tLayout('privacy')}
            </a>
          </p>
        )}
      </section>
    </article>
  );
}
