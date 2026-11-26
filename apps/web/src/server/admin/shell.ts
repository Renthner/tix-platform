import { countInvoiceCorrections, getAdminTodoCounts } from '@tix/core';
import { cache } from 'react';
import { allowedNavKeys } from '@/lib/admin-nav-access';
import { buildSidebar, type NavKey, type SidebarSection } from '@/lib/admin-nav-model';
import { getAdminSession, hasRole } from '@/server/auth';
import { getCore } from '@/server/core';

export type AdminTodoKey =
  | 'bankReview'
  | 'overdueTransfers'
  | 'openRefunds'
  | 'openAdjustments'
  | 'invoiceCorrections'
  | 'waitlistPending'
  | 'expiringCodes';

export interface AdminTodo {
  key: AdminTodoKey;
  count: number;
  href: string;
}

export interface AdminShellData {
  keys: NavKey[];
  sections: SidebarSection[];
  /** Open to-dos for this user's roles (same data as the dashboard tiles), count > 0 only. */
  todos: AdminTodo[];
  todoTotal: number;
}

/**
 * Navigation and to-do data of the admin shell (sidebar, mobile menu, notification bell), loaded
 * once per request. Null without a usable session (or while the two-factor setup is forced).
 * A failing count never breaks the shell: it shows as zero.
 */
export const loadAdminShellData = cache(async (): Promise<AdminShellData | null> => {
  const session = await getAdminSession();
  if (!session || session.twoFactorSetupRequired) return null;
  const keys = allowedNavKeys(session.roles);
  const finance = hasRole(session, ['FINANCE']);
  const eventManager = hasRole(session, ['EVENT_MANAGER']);
  const core = getCore();
  const [counts, invoiceCorrections] = await Promise.all([
    finance || eventManager ? getAdminTodoCounts(core).catch(() => null) : null,
    finance ? countInvoiceCorrections(core).catch(() => 0) : 0,
  ]);
  const todos: AdminTodo[] = [];
  if (counts && finance) {
    todos.push(
      { key: 'bankReview', count: counts.bankReview, href: '/admin/banking/review' },
      { key: 'overdueTransfers', count: counts.overdueTransfers, href: '/admin/orders?overdue=1' },
      { key: 'openRefunds', count: counts.openRefunds, href: '/admin/refunds' },
      { key: 'openAdjustments', count: counts.openAdjustments, href: '/admin/refunds' },
    );
  }
  if (finance) {
    todos.push({ key: 'invoiceCorrections', count: invoiceCorrections, href: '/admin/refunds' });
  }
  if (counts && eventManager) {
    todos.push(
      { key: 'waitlistPending', count: counts.waitlistPending, href: '/admin/events' },
      { key: 'expiringCodes', count: counts.expiringCodes, href: '/admin/events' },
    );
  }
  const badges: Partial<Record<NavKey, number>> = {};
  if (keys.includes('refunds') && counts) {
    // Open refunds plus unpaid additional payments (tariff changes) plus invoice corrections.
    badges.refunds = counts.openRefunds + counts.openAdjustments + invoiceCorrections;
  }
  if (keys.includes('banking') && counts) badges.banking = counts.bankReview;
  const open = todos.filter((t) => t.count > 0);
  return {
    keys,
    sections: buildSidebar(keys, badges),
    todos: open,
    todoTotal: open.reduce((sum, t) => sum + t.count, 0),
  };
});
