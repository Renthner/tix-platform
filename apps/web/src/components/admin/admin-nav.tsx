import {
  countAdjustmentsNeedingAttention,
  countBankReview,
  countInvoiceCorrections,
  countOpenRefunds,
} from '@tix/core';
import { allowedNavKeys } from '@/lib/admin-nav-access';
import { getAdminSession } from '@/server/auth';
import { getCore } from '@/server/core';
import type { ReactNode } from 'react';
import { AdminMobileMenu, AdminNavLinks, type NavKey } from './admin-nav-links';

/** Server component: filters the navigation by the signed-in admin's roles. */
export async function AdminNav({
  mobile = false,
  mobileFooter,
}: {
  mobile?: boolean;
  mobileFooter?: ReactNode;
} = {}) {
  const session = await getAdminSession();
  if (!session || session.twoFactorSetupRequired) return null;
  const keys = allowedNavKeys(session.roles);
  const badges: Partial<Record<NavKey, number>> = keys.includes('refunds')
    ? {
        // Open refunds plus unpaid additional payments (tariff changes) whose reminder went out.
        refunds: await Promise.all([
          countOpenRefunds(getCore()).catch(() => 0),
          countAdjustmentsNeedingAttention(getCore()).catch(() => 0),
          countInvoiceCorrections(getCore()).catch(() => 0),
        ]).then(([refunds, adjustments, invoices]) => refunds + adjustments + invoices),
      }
    : {};
  if (keys.includes('banking')) {
    // Klärfälle waiting in the bank review queue.
    badges.banking = await countBankReview(getCore()).catch(() => 0);
  }
  if (mobile) {
    return (
      <AdminMobileMenu keys={keys} badges={badges}>
        {mobileFooter}
      </AdminMobileMenu>
    );
  }
  return <AdminNavLinks keys={keys} badges={badges} />;
}
