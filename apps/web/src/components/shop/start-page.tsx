import { sanitizeCustomHtml } from '@tix/core';
import { mediaAssets } from '@tix/db';
import { resolveStartPageHtml, resolveStartPageTexts, type StartPageSettings } from '@tix/shared';
import { inArray } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { RICH_TEXT_CLASS } from '@/lib/rich-text-styles';
import { cn } from '@/lib/utils';
import { getCore } from '@/server/core';
import { descriptionToHtml, richTextToPlain } from '@/server/rich-text';

type Size = { width: number | null; height: number | null };

/** Image aspect clamped to a sensible band so extreme panoramas / portraits don't dominate. */
function aspect({ width, height }: Size, min: number, max: number): number {
  if (!width || !height) return 16 / 9;
  return Math.min(Math.max(width / height, min), max);
}

/** Sanitised custom HTML when HTML mode is on and a text exists for the locale/default locale. */
function customHtml(settings: StartPageSettings, locale: string, defaultLocale: string): string {
  if (settings.mode !== 'HTML') return '';
  return sanitizeCustomHtml(resolveStartPageHtml(settings, locale, defaultLocale));
}

/**
 * True when the admin configured anything visible; otherwise the shop keeps its built-in
 * "no events" text.
 */
export function hasStartPageContent(
  settings: StartPageSettings,
  locale: string,
  defaultLocale: string,
): boolean {
  if (customHtml(settings, locale, defaultLocale)) return true;
  const r = resolveStartPageTexts(settings, locale, defaultLocale);
  return !!(
    r.headline ||
    r.subheadline ||
    richTextToPlain(r.body) ||
    settings.heroAssetId ||
    settings.galleryAssetIds.length
  );
}

/** Shop home page while no event is published (configured under Settings → Appearance). */
export async function StartPage({
  settings,
  locale,
  defaultLocale,
}: {
  settings: StartPageSettings;
  locale: string;
  defaultLocale: string;
}) {
  const custom = customHtml(settings, locale, defaultLocale);
  if (custom) {
    // Sanitised with the wide custom-HTML allowlist (no scripts/frames/handlers), also on save.
    // No prose styles here so the admin's own CSS controls the look.
    return <div className="tix-start-custom" dangerouslySetInnerHTML={{ __html: custom }} />;
  }
  const t = await getTranslations('shop.home');
  const r = resolveStartPageTexts(settings, locale, defaultLocale);
  const ids = [
    ...(settings.heroAssetId ? [settings.heroAssetId] : []),
    ...settings.galleryAssetIds,
  ];
  const sizes = new Map<string, Size>();
  if (ids.length) {
    const rows = await getCore()
      .db.select({ id: mediaAssets.id, width: mediaAssets.width, height: mediaAssets.height })
      .from(mediaAssets)
      .where(inArray(mediaAssets.id, ids));
    for (const row of rows) sizes.set(row.id, row);
  }
  const hero = settings.heroAssetId ? (sizes.get(settings.heroAssetId) ?? null) : null;
  const overlay = settings.layout === 'OVERLAY' && !!hero;
  const bodyHtml = richTextToPlain(r.body) ? descriptionToHtml(r.body) : '';
  const showButton = !!(r.buttonLabel && settings.buttonUrl);
  const external = !!settings.buttonUrl && !settings.buttonUrl.startsWith('/');

  const heading = r.headline ? (
    <h1
      className={cn(
        'text-3xl font-semibold tracking-tight sm:text-4xl',
        overlay && 'text-white drop-shadow',
      )}
    >
      {r.headline}
    </h1>
  ) : (
    <h1 className="sr-only">{t('title')}</h1>
  );
  const textBlock = (
    <div className={cn('space-y-3', overlay && 'text-white')}>
      {heading}
      {r.subheadline && (
        <p
          className={cn('text-lg', overlay ? 'text-white/90 drop-shadow' : 'text-muted-foreground')}
        >
          {r.subheadline}
        </p>
      )}
      {bodyHtml && (
        <div
          className={cn(
            'max-w-3xl',
            RICH_TEXT_CLASS,
            overlay && '[&_a]:text-white [&_a]:underline',
          )}
          // Sanitised with the rich-text allowlist (also on save).
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
      {showButton && (
        <div className="pt-1">
          <Button asChild size="lg" variant={overlay ? 'secondary' : 'default'}>
            {external ? (
              <a href={settings.buttonUrl} rel="noopener noreferrer">
                {r.buttonLabel}
              </a>
            ) : (
              <Link href={settings.buttonUrl!}>{r.buttonLabel}</Link>
            )}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      {overlay && settings.heroAssetId && hero ? (
        <section className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted sm:aspect-[16/9] lg:aspect-[21/9]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media/${settings.heroAssetId}`}
            alt={r.heroAlt}
            width={hero.width ?? 1600}
            height={hero.height ?? 900}
            fetchPriority="high"
            className="absolute inset-0 size-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/45 to-black/20" />
          <div className="absolute inset-x-0 bottom-0 p-5 sm:p-8">{textBlock}</div>
        </section>
      ) : (
        <>
          {hero && settings.heroAssetId && (
            <div
              className="w-full overflow-hidden rounded-xl bg-muted"
              style={{ aspectRatio: aspect(hero, 1, 21 / 9) }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/media/${settings.heroAssetId}`}
                alt={r.heroAlt}
                width={hero.width ?? 1600}
                height={hero.height ?? 900}
                fetchPriority="high"
                className="size-full object-cover"
              />
            </div>
          )}
          <section>{textBlock}</section>
        </>
      )}
      {settings.galleryAssetIds.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {settings.galleryAssetIds.map((id, i) => {
            const size = sizes.get(id) ?? { width: null, height: null };
            return (
              <div key={id} className="aspect-[4/3] overflow-hidden rounded-lg bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${id}`}
                  alt={r.galleryAlt[i] ?? ''}
                  width={size.width ?? 1200}
                  height={size.height ?? 900}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
