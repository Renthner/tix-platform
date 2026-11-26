import { listAdminUsers } from '@tix/core';
import { buildQuery } from '@tix/shared';
import { Users } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminPageHeader } from '@/components/admin/page-header';
import { StatusTabs } from '@/components/admin/status-tabs';
import { UserStatusBadge, userStatus, type UserStatus } from '@/components/admin/users/user-status';
import { InviteUserDialog } from '@/components/admin/users/users-forms';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { inviteUserAction } from '@/server/admin/users';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.users');
  return { title: t('title') };
}

const STATUS_TABS = ['active', 'invited', 'locked', 'inactive'] as const satisfies UserStatus[];

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdmin(['SUPER_ADMIN']);
  const sp = await searchParams;
  const [t, tl, format, users] = await Promise.all([
    getTranslations('adminSecurity.users'),
    getTranslations('admin.list'),
    getFormatter(),
    listAdminUsers(getCore()),
  ]);
  const now = new Date();
  const withStatus = users.map((u) => ({ ...u, status: userStatus(u, now) }));
  const active = (STATUS_TABS as readonly string[]).includes(sp.status ?? '')
    ? (sp.status as UserStatus)
    : null;
  const rows = active ? withStatus.filter((u) => u.status === active) : withStatus;
  const base = '/admin/users';
  const tabs = [
    {
      key: 'all',
      label: tl('all'),
      href: base,
      active: active === null,
      count: withStatus.length,
      'data-testid': 'users-tab-all',
    },
    ...STATUS_TABS.map((key) => ({
      key,
      label: t(`status.${key}`),
      href: buildQuery(base, { status: key }),
      active: active === key,
      count: withStatus.filter((u) => u.status === key).length,
      'data-testid': `users-tab-${key}`,
    })),
  ];

  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('administration')}
        title={t('title')}
        description={t('description')}
        actions={<InviteUserDialog action={inviteUserAction} />}
      />
      <div className="max-w-5xl space-y-4 p-6">
        <StatusTabs label={t('tabsLabel')} tabs={tabs} />
        <Card className="py-0">
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <EmptyState
                icon={Users}
                title={t('empty')}
                description={active ? tl('emptyFiltered') : undefined}
                action={
                  active ? (
                    <Link href={base} className="text-sm underline-offset-4 hover:underline">
                      {tl('reset')}
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">{t('columns.name')}</th>
                      <th className="px-3 py-2">{t('columns.roles')}</th>
                      <th className="px-3 py-2">{t('columns.status')}</th>
                      <th className="px-3 py-2">{t('columns.twoFactor')}</th>
                      <th className="px-3 py-2">{t('columns.lastLogin')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr key={u.id} className="border-t">
                        <td className="px-3 py-2">
                          <Link
                            href={`/admin/users/${u.id}`}
                            className="font-medium hover:underline"
                          >
                            {u.displayName}
                          </Link>
                          <div className="text-xs text-muted-foreground">{u.email}</div>
                        </td>
                        <td className="px-3 py-2">
                          {u.roles.map((r) => t(`role.${r}`)).join(', ')}
                        </td>
                        <td className="px-3 py-2">
                          <UserStatusBadge status={u.status} label={t(`status.${u.status}`)} />
                        </td>
                        <td className="px-3 py-2">{u.twoFactorEnabled ? t('on') : t('off')}</td>
                        <td className="px-3 py-2">
                          {u.lastLoginAt
                            ? format.dateTime(u.lastLoginAt, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })
                            : t('never')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
