import type { AlertHistoryRow } from '@tix/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { BellOff } from 'lucide-react';
import { EmptyState } from '@/components/admin/empty-state';
import { SettingsSection } from '@/components/admin/settings-forms';

/** Last warning e-mails of the installation (System page). */
export async function AlertHistory({ rows }: { rows: AlertHistoryRow[] }) {
  const [t, format] = await Promise.all([getTranslations('system.alerts'), getFormatter()]);
  const when = (d: Date) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <SettingsSection
      id="alertHistory"
      title={t('history.title')}
      description={t('history.description')}
    >
      {rows.length === 0 ? (
        <EmptyState icon={BellOff} size="sm" title={t('history.empty')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="alert-history">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">{t('history.type')}</th>
                <th className="py-2 pr-4 font-medium">{t('history.firstSeen')}</th>
                <th className="py-2 pr-4 font-medium">{t('history.lastSent')}</th>
                <th className="py-2 font-medium">{t('history.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{t(`types.${r.type}.name`)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{when(r.firstSeenAt)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {r.lastSentAt
                      ? `${when(r.lastSentAt)} (${t('history.times', { count: r.sendCount })})`
                      : t('history.neverSent')}
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    {r.resolvedAt
                      ? t('history.resolved', { time: when(r.resolvedAt) })
                      : t('history.open')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}
