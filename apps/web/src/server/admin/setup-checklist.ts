'use server';

import { saveSetting } from '@tix/core';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';

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
