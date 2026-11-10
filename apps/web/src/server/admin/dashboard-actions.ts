'use server';

import { saveDashboardPreferences } from '@tix/core';
import { dashboardPreferencesInputSchema } from '@tix/shared';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

/** Saves card order / status filter of the signed-in admin only (any admin role may do so). */
export async function saveDashboardPreferencesAction(input: unknown): Promise<{ ok: boolean }> {
  const session = await requireAdmin();
  if (!dashboardPreferencesInputSchema.safeParse(input).success) return { ok: false };
  await saveDashboardPreferences(getCore(), session.userId, input);
  return { ok: true };
}
