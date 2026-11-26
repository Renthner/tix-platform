import type { ReactNode } from 'react';
import { loadAdminShellData } from '@/server/admin/shell';
import { AdminMobileMenu, AdminNavLinks } from './admin-nav-links';

/** Server component: the admin navigation filtered by the signed-in admin's roles. */
export async function AdminNav({
  mobile = false,
  mobileFooter,
}: {
  mobile?: boolean;
  mobileFooter?: ReactNode;
} = {}) {
  const data = await loadAdminShellData();
  if (!data) return null;
  if (mobile) {
    return <AdminMobileMenu sections={data.sections}>{mobileFooter}</AdminMobileMenu>;
  }
  return <AdminNavLinks sections={data.sections} />;
}
