import { getAdminUserActivity, getAdminUserSummary } from '@tix/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { DetailLayout } from '@/components/admin/detail-layout';
import { AdminPageHeader } from '@/components/admin/page-header';
import { SettingsSection } from '@/components/admin/settings-forms';
import { UserStatusBadge, userStatus } from '@/components/admin/users/user-status';
import { EditUserForm, UserHeaderActions } from '@/components/admin/users/users-forms';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { updateUserAction, userOperationAction } from '@/server/admin/users';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.users');
  return { title: t('title') };
}

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
  const now = new Date();
  const status = userStatus(user, now);
  const dateTime = (d: Date) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          ...(await hubBreadcrumbs('administration')),
          { label: t('title'), href: '/admin/users' },
        ]}
        title={user.displayName}
        description={user.email}
        actions={
          <UserHeaderActions
            userId={user.id}
            isActive={user.isActive}
            invitePending={user.invitePending}
            canDeleteInvite={user.invitePending && user.lastLoginAt === null}
            hasTwoFactor={user.twoFactorEnabled}
            locked={Boolean(user.lockedUntil && user.lockedUntil > now)}
            self={user.id === session.userId}
            activeSessions={activity.activeSessions}
            run={userOperationAction}
          />
        }
      />
      <DetailLayout
        className="max-w-6xl"
        aside={
          <>
            <SettingsSection id="account" title={t('operations.title')}>
              <dl className="grid gap-x-4 gap-y-2 text-sm" data-testid="user-facts">
                <dt className="text-muted-foreground">{t('columns.status')}</dt>
                <dd>
                  <UserStatusBadge status={status} label={t(`status.${status}`)} />
                </dd>
                <dt className="text-muted-foreground">{t('detail.email')}</dt>
                <dd className="break-all">{user.email}</dd>
                <dt className="text-muted-foreground">{t('columns.roles')}</dt>
                <dd>{user.roles.map((r) => t(`role.${r}`)).join(', ')}</dd>
                <dt className="text-muted-foreground">{t('columns.twoFactor')}</dt>
                <dd>{user.twoFactorEnabled ? t('on') : t('off')}</dd>
                <dt className="text-muted-foreground">{t('detail.createdAt')}</dt>
                <dd>{dateTime(user.createdAt)}</dd>
              </dl>
            </SettingsSection>
            <SettingsSection id="activity" title={t('activity.title')}>
              <dl className="grid gap-x-4 gap-y-2 text-sm" data-testid="user-activity">
                <dt className="text-muted-foreground">{t('activity.lastSignIn')}</dt>
                <dd>{activity.lastLoginAt ? dateTime(activity.lastLoginAt) : t('never')}</dd>
                <dt className="text-muted-foreground">{t('activity.lastIp')}</dt>
                <dd className="font-mono">{activity.lastLoginIp ?? '–'}</dd>
                <dt className="text-muted-foreground">{t('activity.activeSessions')}</dt>
                <dd>{activity.activeSessions}</dd>
              </dl>
            </SettingsSection>
          </>
        }
      >
        <SettingsSection id="edit" title={t('edit.title')}>
          <EditUserForm
            action={updateUserAction.bind(null, user.id)}
            displayName={user.displayName}
            roles={user.roles}
          />
        </SettingsSection>
      </DetailLayout>
    </>
  );
}
