import {
  getSetting,
  listApkReleases,
  listScannerDevices,
  listScannerEventOptions,
  resolveScannerServerUrl,
} from '@tix/core';
import { APP_VERSION } from '@tix/shared';
import { TriangleAlert } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { ApkSection } from '@/components/admin/scanners/apk-section';
import { PairDeviceDialog } from '@/components/admin/scanners/pair-device-dialog';
import { ScannerDevices } from '@/components/admin/scanners/scanner-devices';
import { SettingsSection } from '@/components/admin/settings-forms';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { resolveLocale } from '@/i18n/locale';
import { Link } from '@/i18n/navigation';
import {
  SCANNER_APK_ROLES,
  SCANNER_MANAGE_ROLES,
  SCANNER_VIEW_ROLES,
} from '@/server/admin/scanners';
import { hasRole, requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('scanners');
  return { title: t('title') };
}

export default async function ScannersPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const session = await requireAdmin(SCANNER_VIEW_ROLES);
  const canManage = hasRole(session, SCANNER_MANAGE_ROLES);
  const canUploadApk = hasRole(session, SCANNER_APK_ROLES);
  const core = getCore();
  const t = await getTranslations('scanners');
  const format = await getFormatter();
  const [devices, eventOptions, releases, server, scannerSettings] = await Promise.all([
    listScannerDevices(core),
    listScannerEventOptions(core),
    listApkReleases(core),
    resolveScannerServerUrl(core),
    getSetting(core, 'scanner'),
  ]);
  const events = eventOptions.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    entrances: e.entrances,
  }));

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={canManage ? <PairDeviceDialog events={events} /> : undefined}
      />
      <div className="space-y-6 p-6">
        {!server.reachableFromPhone ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>{t('serverWarning.title')}</AlertTitle>
            <AlertDescription>
              <p>
                {server.url
                  ? t('serverWarning.text', { url: server.url })
                  : t('serverWarning.textMissing')}
              </p>
              {hasRole(session, ['SUPER_ADMIN']) ? (
                <Button asChild variant="outline" size="sm" className="mt-2">
                  <Link href="/admin/settings/scanner">{t('serverWarning.link')}</Link>
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {server.insecure ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{t('insecureWarning.title')}</AlertTitle>
            <AlertDescription>
              {t('insecureWarning.text', { url: server.url ?? '' })}
            </AlertDescription>
          </Alert>
        ) : null}

        <SettingsSection id="devices" title={t('devices.title')}>
          <ScannerDevices
            serverVersion={APP_VERSION}
            canManage={canManage}
            events={events}
            devices={devices.map((d) => ({
              id: d.id,
              name: d.name,
              appVersion: d.appVersion,
              deviceModel: d.deviceModel,
              isActive: d.isActive,
              lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
              lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
              assignments: d.assignments,
            }))}
          />
        </SettingsSection>

        <SettingsSection id="app" title={t('apk.title')}>
          <ApkSection
            canUpload={canUploadApk}
            source={scannerSettings.appUpdateSource}
            githubRepository={scannerSettings.githubRepository}
            serverVersion={APP_VERSION}
            canEditSettings={hasRole(session, ['SUPER_ADMIN'])}
            releases={releases.map((r) => ({
              id: r.id,
              versionName: r.versionName,
              versionCode: r.versionCode,
              sizeBytes: r.sizeBytes,
              sha256: r.sha256,
              notes: r.notes,
              isCurrent: r.isCurrent,
              createdAt: r.createdAt.toISOString(),
            }))}
          />
        </SettingsSection>

        <SettingsSection id="events" title={t('events.title')}>
          {eventOptions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('events.empty')}</p>
          ) : (
            <ul className="divide-y">
              {eventOptions.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span>
                    <span className="font-medium">{event.title}</span>
                    <span className="ml-2 text-muted-foreground">
                      {format.dateTime(event.startsAt, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </span>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/scanners/events/${event.id}`}>{t('events.open')}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      </div>
    </>
  );
}
