import { listAdminUsers } from '@tix/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { SettingsSection } from '@/components/admin/settings-forms';
import { InviteUserForm } from '@/components/admin/users/users-forms';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/i18n/navigation';
import { inviteUserAction } from '@/server/admin/users';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('adminSecurity.users');
  return { title: t('title') };
}

export default async function UsersPage() {
  await requireAdmin(['SUPER_ADMIN']);
  const [t, format, users] = await Promise.all([
    getTranslations('adminSecurity.users'),
    getFormatter(),
    listAdminUsers(getCore()),
  ]);
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="max-w-5xl space-y-6 p-6">
        <div className="overflow-x-auto rounded-xl border">
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
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="px-3 py-2">
                    <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                      {u.displayName}
                    </Link>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </td>
                  <td className="px-3 py-2">{u.roles.map((r) => t(`role.${r}`)).join(', ')}</td>
                  <td className="px-3 py-2">
                    {u.isActive && u.lockedUntil && u.lockedUntil > new Date() ? (
                      <Badge variant="destructive">{t('status.locked')}</Badge>
                    ) : !u.isActive ? (
                      <Badge variant="secondary">{t('status.inactive')}</Badge>
                    ) : u.invitePending ? (
                      <Badge variant="outline">{t('status.invited')}</Badge>
                    ) : (
                      <Badge>{t('status.active')}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">{u.twoFactorEnabled ? t('on') : t('off')}</td>
                  <td className="px-3 py-2">
                    {u.lastLoginAt
                      ? format.dateTime(u.lastLoginAt, { dateStyle: 'medium', timeStyle: 'short' })
                      : t('never')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SettingsSection
          id="invite"
          title={t('invite.title')}
          description={t('invite.description')}
        >
          <InviteUserForm action={inviteUserAction} />
        </SettingsSection>
      </div>
    </>
  );
}
