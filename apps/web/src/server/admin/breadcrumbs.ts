import { getTranslations } from 'next-intl/server';
import type { Breadcrumb } from '@/components/admin/page-header';
import { NAV_HREFS, type NavKey } from '@/lib/admin-nav-model';

/**
 * Breadcrumb trail for a page reached through a hub or a list ("Design › Media library",
 * "Events › Demo Concert").
 */
export async function hubBreadcrumbs(hub: NavKey): Promise<Breadcrumb[]> {
  const t = await getTranslations('admin.nav');
  return [{ label: t(hub), href: NAV_HREFS[hub] }];
}
