import type { ReactNode } from 'react';
import { AdminPageHeader, type Breadcrumb } from '@/components/admin/page-header';
import { bankingStats } from '@/server/admin/banking-queries';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { BankingTabs } from './banking-ui';

/**
 * Frame of a banking page (server component): page header (breadcrumbs "Banking › …", title,
 * description, actions), the banking section navigation and the page content. `trail` lists the
 * parent pages below the banking overview; the overview itself passes `root`.
 */
export async function BankingPage({
  title,
  description,
  actions,
  trail = [],
  root = false,
  reviewCount,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  trail?: readonly Breadcrumb[];
  root?: boolean;
  /** Open clarification cases (badge of the "Clarification cases" tab); fetched when omitted. */
  reviewCount?: number;
  children: ReactNode;
}) {
  const [hub, stats] = await Promise.all([
    root ? Promise.resolve([]) : hubBreadcrumbs('banking'),
    reviewCount === undefined ? bankingStats() : Promise.resolve(null),
  ]);
  return (
    <>
      <AdminPageHeader
        breadcrumbs={[...hub, ...trail]}
        title={title}
        description={description}
        actions={actions}
      />
      <BankingTabs reviewCount={reviewCount ?? stats?.review ?? 0} />
      <div className="space-y-6 p-6">{children}</div>
    </>
  );
}
