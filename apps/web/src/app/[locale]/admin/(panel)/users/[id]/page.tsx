import { getAdminUserSummary } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader } from '@/components/admin/form-controls';
import { SettingsSection } from '@/components/admin/settings-forms';
import { EditUserForm, UserOperations } from '@/components/admin/users/users-forms';
import { Link } from '@/i18n/navigation';
import { updateUserAction, userOperationAction } from '@/server/admin/users';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(['SUPER_ADMIN']);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [t, user] = await Promise.all([
    getTranslations('adminSecurity.users'),
    getAdminUserSummary(getCore(), id),
  ]);
  if (!user) notFound();
  return (
    <>
      <PageHeader
        title={user.displayName}
        description={user.email}
        actions={
          <Link href="/admin/users" className="text-sm underline">
            {t('back')}
          </Link>
        }
      />
      <div className="max-w-3xl space-y-6 p-6">
        <SettingsSection id="edit" title={t('edit.title')}>
          <EditUserForm
            action={updateUserAction.bind(null, user.id)}
            displayName={user.displayName}
            roles={user.roles}
          />
        </SettingsSection>
        <SettingsSection id="operations" title={t('operations.title')}>
          <UserOperations
            userId={user.id}
            isActive={user.isActive}
            invitePending={user.invitePending}
            canDeleteInvite={user.invitePending && user.lastLoginAt === null}
            hasTwoFactor={user.twoFactorEnabled}
            locked={Boolean(user.lockedUntil && user.lockedUntil > new Date())}
            self={user.id === session.userId}
            run={userOperationAction}
          />
        </SettingsSection>
      </div>
    </>
  );
}
