import type { SeoSettings } from './schemas/settings';

/** Placeholder for the site title inside the title template. */
export const SITE_TITLE_PLACEHOLDER = '{siteTitle}';
/** Title template of a fresh installation: "<page> · <site title>". */
export const DEFAULT_TITLE_TEMPLATE = `%s · ${SITE_TITLE_PLACEHOLDER}`;
export const SEO_DESCRIPTION_MAX = 300;
export const SEO_SITE_TITLE_MAX = 120;

/** A title template contains the page title token `%s` exactly once. */
export function isValidTitleTemplate(template: string): boolean {
  return template.split('%s').length === 2;
}

/** Template with `{siteTitle}` filled in; `%s` stays for Next's `title.template`. */
export function expandTitleTemplate(template: string, siteTitle: string): string {
  return template.split(SITE_TITLE_PLACEHOLDER).join(siteTitle);
}

/** Final document title of a page (`pageTitle` = the page's own title, without site name). */
export function applyTitleTemplate(template: string, pageTitle: string, siteTitle: string): string {
  const expanded = expandTitleTemplate(template, siteTitle);
  const at = expanded.indexOf('%s');
  return at < 0 ? expanded : expanded.slice(0, at) + pageTitle + expanded.slice(at + 2);
}

type SeoTexts = Pick<SeoSettings, 'texts'>;

function pick(
  seo: SeoTexts,
  locale: string,
  defaultLocale: string,
  field: 'siteTitle' | 'description',
): string | undefined {
  const t = seo.texts as Record<string, { siteTitle?: string; description?: string } | undefined>;
  return t[locale]?.[field] || t[defaultLocale]?.[field] || undefined;
}

/** Site title of `locale` (else the shop default locale's, else the shop name). */
export function resolveSiteTitle(
  seo: SeoTexts,
  locale: string,
  defaultLocale: string,
  shopName: string,
): string {
  return pick(seo, locale, defaultLocale, 'siteTitle') ?? shopName;
}

/** Default meta description of `locale` (else the shop default locale's), if any is configured. */
export function resolveSeoDescription(
  seo: SeoTexts,
  locale: string,
  defaultLocale: string,
): string | undefined {
  return pick(seo, locale, defaultLocale, 'description');
}
