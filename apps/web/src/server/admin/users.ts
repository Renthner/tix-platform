'use server';

import {
  deleteAdminInvite,
  inviteAdminUser,
  resendAdminInvite,
  resetAdminTwoFactor,
  setAdminUserActive,
  unlockAdminUser,
  updateAdminUser,
} from '@tix/core';
import { ADMIN_ROLES, SUPPORTED_LOCALES, type AdminRole, type AppLocale } from '@tix/shared';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import type { SecurityState } from '@/lib/security-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { clientIp } from '@/server/http';
import { fail, guarded, ok } from '@/server/security-action';

/** User management: SUPER_ADMIN only. Every operation is audited in the core. */
async function superAdmin() {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const ip = await clientIp();
  const locale = await getLocale();
  return {
    actor: { userId: session.userId, ipAddress: ip === '0.0.0.0' ? null : ip },
    locale: ((SUPPORTED_LOCALES as readonly string[]).includes(locale)
      ? locale
      : 'en') as AppLocale,
  };
}

const userId = z.uuid();

function readRoles(fd: FormData): AdminRole[] {
  return fd
    .getAll('roles')
    .filter((r): r is AdminRole => (ADMIN_ROLES as readonly string[]).includes(String(r)));
}

export async function inviteUserAction(_prev: SecurityState, fd: FormData): Promise<SecurityState> {
  const { actor, locale } = await superAdmin();
  const parsed = z
    .object({
      email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
      displayName: z.string().trim().min(1).max(120),
    })
    .safeParse({ email: fd.get('email'), displayName: fd.get('displayName') });
  const roles = readRoles(fd);
  if (!parsed.success || roles.length === 0) return fail('VALIDATION');
  const result = await guarded(async () => {
    await inviteAdminUser(getCore(), actor, { ...parsed.data, roles, locale });
    return ok({ message: 'invited' });
  });
  revalidatePath('/admin/users');
  return result;
}

export async function updateUserAction(
  id: string,
  _prev: SecurityState,
  fd: FormData,
): Promise<SecurityState> {
  const { actor } = await superAdmin();
  const name = String(fd.get('displayName') ?? '').trim();
  const roles = readRoles(fd);
  if (!userId.safeParse(id).success || name === '' || name.length > 120 || roles.length === 0) {
    return fail('VALIDATION');
  }
  const result = await guarded(async () => {
    await updateAdminUser(getCore(), actor, id, { displayName: name, roles });
    return ok({ message: 'userSaved' });
  });
  revalidatePath('/admin/users', 'layout');
  return result;
}

export type UserOperation =
  'activate' | 'deactivate' | 'unlock' | 'resetTwoFactor' | 'resendInvite' | 'deleteInvite';

/** Single-button operations on a user. */
export async function userOperationAction(
  id: string,
  operation: UserOperation,
): Promise<SecurityState> {
  const { actor, locale } = await superAdmin();
  if (!userId.safeParse(id).success) return fail('VALIDATION');
  const core = getCore();
  const result = await guarded(async () => {
    switch (operation) {
      case 'activate':
        await setAdminUserActive(core, actor, id, true);
        return ok({ message: 'reactivated' });
      case 'deactivate':
        await setAdminUserActive(core, actor, id, false);
        return ok({ message: 'deactivated' });
      case 'unlock':
        await unlockAdminUser(core, actor, id);
        return ok({ message: 'unlocked' });
      case 'resetTwoFactor':
        await resetAdminTwoFactor(core, actor, id);
        return ok({ message: 'twoFactorReset' });
      case 'resendInvite':
        await resendAdminInvite(core, actor, id, locale);
        return ok({ message: 'inviteResent' });
      case 'deleteInvite':
        await deleteAdminInvite(core, actor, id);
        return ok({ message: 'inviteDeleted' });
    }
  });
  revalidatePath('/admin/users', 'layout');
  if (result.status === 'success' && operation === 'deleteInvite') {
    return redirect({ href: '/admin/users', locale: await getLocale() });
  }
  return result;
}
