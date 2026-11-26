import { useTranslations } from 'next-intl';
import { PageHeaderLayout, type PageHeaderProps } from './page-header-layout';

export type { Breadcrumb, PageHeaderProps } from './page-header-layout';

/**
 * Header of an admin page: optional breadcrumbs (parent pages; the h1 is the current page), the
 * page title (h1), an optional description and actions aligned right (wrapping on phones).
 * Works in server and client components.
 */
export function AdminPageHeader(props: PageHeaderProps) {
  const t = useTranslations('admin.shell');
  return <PageHeaderLayout {...props} breadcrumbsLabel={t('breadcrumbs')} />;
}
