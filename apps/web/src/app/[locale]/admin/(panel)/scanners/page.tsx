import {
  getSetting,
  listApkReleases,
  listScannerDevices,
  listScannerEventOptions,
  resolveScannerServerUrl,
} from '@tix/core';
import { APP_VERSION } from '@tix/shared';
import { CalendarX2, ChevronRight, TriangleAlert } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { DetailLayout, DetailSection } from '@/components/admin/detail-layout';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminPageHeader } from '@/components/admin/page-header';
import { ApkSection } from '@/components/admin/scanners/apk-section';
import { PairDeviceDialog } from '@/components/admin/scanners/pair-device-dialog';
import { ScannerDevices } from '@/components/admin/scanners/scanner-devices';
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
      <AdminPageHeader
        title={t('title')}
        description={t('description')}
        actions={canManage ? <PairDeviceDialog events={events} /> : undefined}
      />
      <DetailLayout
        asideFirstOnMobile
        aside={
          <DetailSection
            title={t('events.title')}
            data-testid="scanner-events"
            contentClassName="px-0"
          >
            {eventOptions.length === 0 ? (
              <EmptyState size="sm" icon={CalendarX2} title={t('events.empty')} />
            ) : (
              <ul className="divide-y border-t">
                {eventOptions.map((event) => (
                  <li key={event.id}>
                    <Link
                      href={`/admin/scanners/events/${event.id}`}
                      className="flex items-center gap-3 px-6 py-2.5 text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{event.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {format.dateTime(event.startsAt, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                      </span>
                      <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>
        }
      >
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

        <DetailSection title={t('devices.title')} data-testid="scanner-devices">
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
        </DetailSection>

        <DetailSection title={t('apk.title')} data-testid="scanner-app">
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
        </DetailSection>
      </DetailLayout>
    </>
  );
}
