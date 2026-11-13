import { getCheckInStats, getSetting, listScanLog, listScanLogDevices } from '@tix/core';
import {
  SCAN_RESULTS,
  SCAN_WARNING_COLOR_KEY,
  readableTextColor,
  scanResultColor,
} from '@tix/shared';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { getCore } from '@/server/core';
import { AutoRefresh } from './auto-refresh';
import { LogFilterForm } from './log-filter-form';

export interface CheckInFilters {
  result?: string;
  device?: string;
  logPage?: string;
  logSize?: string;
  logQ?: string;
}

export const LOG_PAGE_SIZES = [5, 10, 15, 20, 25, 30, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

/** Live check-in statistics and the filterable scan journal of one event. */
export async function CheckInPanel({
  eventId,
  basePath,
  filters,
}: {
  eventId: string;
  basePath: string;
  filters: CheckInFilters;
}) {
  const core = getCore();
  const t = await getTranslations('scanners.checkIn');
  const format = await getFormatter();
  const result = SCAN_RESULTS.find((r) => r === filters.result);
  const deviceId = /^[0-9a-f-]{36}$/i.test(filters.device ?? '') ? filters.device : undefined;
  const requestedPage = Math.max(1, Number.parseInt(filters.logPage ?? '1', 10) || 1);
  const sizeParam = Number.parseInt(filters.logSize ?? '', 10);
  const pageSize = LOG_PAGE_SIZES.includes(sizeParam) ? sizeParam : DEFAULT_PAGE_SIZE;
  const search = (filters.logQ ?? '').trim().slice(0, 100);
  const [stats, log, devices, scannerSettings] = await Promise.all([
    getCheckInStats(core, eventId),
    listScanLog(core, { eventId, result, deviceId, search, page: requestedPage, pageSize }),
    listScanLogDevices(core, eventId),
    getSetting(core, 'scanner'),
  ]);
  const colors = scannerSettings.resultColors;
  const pages = Math.max(1, Math.ceil(log.total / pageSize));
  const percent = stats.valid > 0 ? Math.round((stats.checkedIn / stats.valid) * 100) : 0;
  const dateTime = (d: Date) => format.dateTime(d, { dateStyle: 'short', timeStyle: 'medium' });
  const query = (nextPage: number) => ({
    ...(result ? { result } : {}),
    ...(deviceId ? { device: deviceId } : {}),
    ...(search ? { logQ: search } : {}),
    ...(pageSize !== DEFAULT_PAGE_SIZE ? { logSize: String(pageSize) } : {}),
    ...(nextPage > 1 ? { logPage: String(nextPage) } : {}),
  });

  const statCards: {
    key: 'valid' | 'checkedIn' | 'checkedOut' | 'notArrived' | 'voided' | 'duplicates';
    value: number;
  }[] = [
    { key: 'valid', value: stats.valid },
    { key: 'checkedIn', value: stats.checkedIn },
    { key: 'checkedOut', value: stats.checkedOut },
    { key: 'notArrived', value: stats.notArrived },
    { key: 'voided', value: stats.voided },
    { key: 'duplicates', value: stats.duplicateEntries },
  ];

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={10} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {statCards.map((card) => (
          <Card key={card.key}>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">{t(`stats.${card.key}`)}</div>
              <div className="text-2xl font-semibold tabular-nums">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-sm">
          <span>{t('stats.progress', { checked: stats.checkedIn, valid: stats.valid })}</span>
          <span className="tabular-nums">{percent}%</span>
        </div>
        <div
          className="h-3 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="text-xs text-muted-foreground">
          {t('stats.lastScan')}: {stats.lastScanAt ? dateTime(stats.lastScanAt) : t('stats.noScan')}
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t('byEntrance.title')}</h2>
        {stats.byEntrance.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('byEntrance.empty')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {stats.byEntrance.map((e) => (
              <li
                key={e.entranceId ?? 'none'}
                className="flex items-center justify-between rounded-md border p-3 text-sm"
              >
                <span>{e.entranceName ?? t('byEntrance.noEntrance')}</span>
                <span className="font-semibold tabular-nums">{e.checkIns}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-base font-semibold">
            {t('log.title')}{' '}
            <span className="text-sm font-normal text-muted-foreground">
              {t('log.total', { count: log.total })}
            </span>
          </h2>
          <LogFilterForm
            result={result ?? ''}
            device={deviceId ?? ''}
            q={search}
            size={pageSize}
            pageSizes={LOG_PAGE_SIZES}
            resultOptions={SCAN_RESULTS.map((r) => ({ value: r, label: t(`results.${r}`) }))}
            deviceOptions={devices.map((d) => ({
              value: d.id,
              label: d.deleted ? `${d.name} (${t('log.deletedSuffix')})` : d.name,
            }))}
            labels={{
              result: t('log.filterResult'),
              device: t('log.filterDevice'),
              search: t('log.search'),
              searchPlaceholder: t('log.searchPlaceholder'),
              pageSize: t('log.pageSize'),
              all: t('log.all'),
            }}
          />
        </div>
        {log.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('log.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('log.time')}</TableHead>
                <TableHead>{t('log.device')}</TableHead>
                <TableHead>{t('log.ticket')}</TableHead>
                <TableHead>{t('log.seat')}</TableHead>
                <TableHead>{t('log.result')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">{dateTime(entry.scannedAt)}</TableCell>
                  <TableCell>
                    {entry.deviceName ?? t('log.unknownDevice')}
                    <span className="block text-xs text-muted-foreground">
                      {[
                        entry.entranceName,
                        entry.wasOffline ? t('log.offline') : null,
                        entry.source === 'MANUAL' ? t('log.manual') : null,
                        entry.action === 'CHECK_OUT' ? t('log.checkOut') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </TableCell>
                  <TableCell>
                    {entry.ticketCode ? (
                      <span className="font-mono text-xs">{entry.ticketCode}</span>
                    ) : (
                      '–'
                    )}
                    {entry.attendeeName ? (
                      <span className="block text-xs text-muted-foreground">
                        {entry.attendeeName}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {entry.seat
                      ? [entry.seat.sectionLabel, entry.seat.rowLabel, entry.seat.seatLabel]
                          .filter(Boolean)
                          .join(' / ')
                      : '–'}
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const bg = scanResultColor(entry.result, entry.warnings, colors);
                      return (
                        <Badge
                          className="border-transparent"
                          style={{ backgroundColor: bg, color: readableTextColor(bg) }}
                        >
                          {t(`results.${entry.result}`)}
                        </Badge>
                      );
                    })()}
                    {entry.message === 'DUPLICATE_ENTRY' ? (
                      <Badge variant="outline" className="ml-1">
                        {t('log.duplicateEntry')}
                      </Badge>
                    ) : null}
                    {entry.warnings.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {entry.warnings.map((w) => {
                          const bg = colors[SCAN_WARNING_COLOR_KEY[w]];
                          return (
                            <Badge
                              key={w}
                              className="border-transparent text-[11px]"
                              style={{ backgroundColor: bg, color: readableTextColor(bg) }}
                            >
                              {t(`warnings.${w}`)}
                            </Badge>
                          );
                        })}
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {log.total > 0 ? (
          <div className="flex items-center justify-between text-sm">
            <span>
              {t('log.page', { page: log.page, pages })} · {t('log.total', { count: log.total })}
            </span>
            <div className="flex gap-2">
              {log.page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={{ pathname: basePath, query: query(log.page - 1) }}>
                    {t('log.previous')}
                  </Link>
                </Button>
              ) : null}
              {log.page < pages ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={{ pathname: basePath, query: query(log.page + 1) }}>
                    {t('log.next')}
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
