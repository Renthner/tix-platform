import { getAdminUserActivity, getAdminUserSummary } from '@tix/core';
import { getFormatter, getTranslations } from 'next-intl/server';
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
  const [t, format, user, activity] = await Promise.all([
    getTranslations('adminSecurity.users'),
    getFormatter(),
    getAdminUserSummary(getCore(), id),
    getAdminUserActivity(getCore(), id),
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
        <SettingsSection id="activity" title={t('activity.title')}>
          <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]" data-testid="user-activity">
            <dt className="text-muted-foreground">{t('activity.lastSignIn')}</dt>
            <dd>
              {activity.lastLoginAt
                ? format.dateTime(activity.lastLoginAt, { dateStyle: 'medium', timeStyle: 'short' })
                : t('never')}
            </dd>
            <dt className="text-muted-foreground">{t('activity.lastIp')}</dt>
            <dd className="font-mono">{activity.lastLoginIp ?? '–'}</dd>
            <dt className="text-muted-foreground">{t('activity.activeSessions')}</dt>
            <dd>{activity.activeSessions}</dd>
          </dl>
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
            activeSessions={activity.activeSessions}
            run={userOperationAction}
          />
        </SettingsSection>
      </div>
    </>
  );
}
