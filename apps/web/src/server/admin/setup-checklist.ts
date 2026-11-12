'use server';

import { saveSetting } from '@tix/core';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { SETUP_COLLAPSED_COOKIE } from './setup-checklist-cookie';

/**
 * Collapses / expands the dashboard "first steps" card for this browser. The path is "/" (not
 * "/admin"): admin URLs carry a locale prefix for non-default languages ("/de/admin"), which a
 * cookie scoped to "/admin" would never be sent to.
 */
export async function setSetupChecklistCollapsedAction(collapsed: boolean): Promise<void> {
  await requireAdmin();
  const store = await cookies();
  if (collapsed) {
    store.set(SETUP_COLLAPSED_COOKIE, '1', {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    store.delete(SETUP_COLLAPSED_COOKIE);
  }
  revalidatePath('/admin');
}

/** Hides the dashboard "first steps" card for everyone (Next.js checks the Origin of server actions). */
export async function dismissSetupChecklistAction(): Promise<void> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  await saveSetting(core, 'setupChecklist', { dismissed: true }, session.userId);
  await audit(core.db, session, 'settings.update', 'system_setting', 'setupChecklist', {
    value: { dismissed: true },
  });
  revalidatePath('/admin');
}

/** Shows the dashboard "first steps" card again (Settings -> General). */
export async function restoreSetupChecklistAction(): Promise<void> {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const core = getCore();
  await saveSetting(core, 'setupChecklist', { dismissed: false }, session.userId);
  await audit(core.db, session, 'settings.update', 'system_setting', 'setupChecklist', {
    value: { dismissed: false },
  });
  revalidatePath('/admin');
  revalidatePath('/admin/settings/general');
}
