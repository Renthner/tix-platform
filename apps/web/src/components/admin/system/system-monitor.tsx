'use client';

import type { SystemStats } from '@tix/core';
import { AlertTriangle, Pause, Play, RefreshCw } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Sparkline, chartColor } from '@/components/admin/statistics/chart-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/** Refresh interval of the live view; the server caches the collection for 3 s across tabs. */
const POLL_MS = 8_000;
/** Samples kept for the sparklines: about ten minutes. */
const MAX_SAMPLES = 75;

interface Samples {
  database: number[];
  redisMemory: number[];
  redisOps: number[];
  sockets: number[];
  shoppers: number[];
  seatLocks: number[];
  backlog: number[];
}
const emptySamples = (): Samples => ({
  database: [],
  redisMemory: [],
  redisOps: [],
  sockets: [],
  shoppers: [],
  seatLocks: [],
  backlog: [],
});

const push = (list: number[], value: number | undefined) =>
  value === undefined ? list : [...list, value].slice(-MAX_SAMPLES);

function addSample(prev: Samples, s: SystemStats): Samples {
  return {
    database: push(prev.database, s.postgres?.connections),
    redisMemory: push(prev.redisMemory, s.redis?.usedMemoryBytes),
    redisOps: push(prev.redisOps, s.redis?.opsPerSecond),
    sockets: push(prev.sockets, s.realtime?.sockets),
    shoppers: push(prev.shoppers, s.waitingRoom?.shopSessions),
    seatLocks: push(prev.seatLocks, s.seatLocks?.total),
    backlog: push(
      prev.backlog,
      s.queues?.reduce((sum, q) => sum + q.waiting + q.active + q.delayed, 0),
    ),
  };
}

function Tile({
  label,
  value,
  detail,
  samples,
  color,
  warn,
}: {
  label: string;
  value: string;
  detail?: string;
  samples: number[];
  color: string;
  warn?: boolean;
}) {
  return (
    <Card className={cn(warn && 'border-destructive/60')}>
      <CardContent className="flex items-start justify-between gap-2 p-4">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
          {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
        </div>
        <Sparkline values={samples} color={color} label={label} />
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent className="overflow-x-auto">{children}</CardContent>
    </Card>
  );
}

export function SystemMonitor({
  initial,
  metricsEnabled,
}: {
  initial: SystemStats;
  metricsEnabled: boolean;
}) {
  const t = useTranslations('system');
  const format = useFormatter();
  const [stats, setStats] = useState(initial);
  const [samples, setSamples] = useState(() => addSample(emptySamples(), initial));
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      const response = await fetch('/api/admin/system/stats', {
        cache: 'no-store',
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as SystemStats;
      setStats(next);
      setSamples((prev) => addSample(prev, next));
      setFailed(false);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setFailed(true);
    } finally {
      if (controller.current === abort) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [paused, load]);
  useEffect(() => () => controller.current?.abort(), []);

  const bytes = (n: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${format.number(v, { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
  };
  const num = (n: number) => format.number(n, { maximumFractionDigits: 0 });
  const duration = (seconds: number) => {
    const d = Math.floor(seconds / 86_400);
    const h = Math.floor((seconds % 86_400) / 3_600);
    const m = Math.floor((seconds % 3_600) / 60);
    if (d > 0) return `${t('units.days', { count: d })} ${t('units.hours', { count: h })}`;
    if (h > 0) return `${t('units.hours', { count: h })} ${t('units.minutes', { count: m })}`;
    if (m > 0) return `${t('units.minutes', { count: m })}`;
    return t('units.seconds', { count: seconds });
  };
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'medium' }) : '–';

  const { postgres, redis, queues, waitingRoom, seatLocks, realtime, workers, backlog } = stats;
  const dbWarn = postgres
    ? postgres.connections / Math.max(1, postgres.maxConnections) > 0.85
    : false;
  const memWarn =
    redis && redis.maxMemoryBytes > 0 ? redis.usedMemoryBytes / redis.maxMemoryBytes > 0.9 : false;
  const failedTotal = queues?.reduce((s, q) => s + q.failed, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span aria-live="polite">
          {t('updated', { time: when(stats.generatedAt) })}
          {!paused && ` · ${t('refreshing', { seconds: POLL_MS / 1000 })}`}
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {paused ? t('resume') : t('pause')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void load()}
            disabled={busy}
          >
            <RefreshCw className={cn('size-4', busy && 'animate-spin')} />
            {t('refreshNow')}
          </Button>
        </div>
      </div>

      {failed && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      )}
      {stats.errors.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>
            {t('collectErrors', {
              blocks: stats.errors.map((b) => t(`blocks.${b}` as 'blocks.redis')).join(', '),
            })}
          </AlertDescription>
        </Alert>
      )}

      <section
        aria-label={t('title')}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{t('overview.app')}</div>
            <div className="mt-1 text-2xl font-semibold">{stats.app.version}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t('overview.uptime', { duration: duration(stats.app.uptimeSeconds) })}
            </div>
            <div className="text-xs text-muted-foreground">
              {t('overview.memory', {
                rss: bytes(stats.app.rssBytes),
                heap: bytes(stats.app.heapUsedBytes),
              })}
            </div>
            <div className="text-xs text-muted-foreground">
              {t('overview.shopCache', {
                ratio:
                  stats.shopCache.hits + stats.shopCache.misses > 0
                    ? format.number(
                        stats.shopCache.hits / (stats.shopCache.hits + stats.shopCache.misses),
                        { style: 'percent', maximumFractionDigits: 0 },
                      )
                    : '–',
                entries: num(stats.shopCache.entries),
                state: stats.shopCache.state,
              })}
            </div>
          </CardContent>
        </Card>
        <Tile
          label={t('overview.database')}
          value={postgres ? num(postgres.connections) : '–'}
          detail={
            postgres
              ? t('overview.databaseDetail', {
                  max: num(postgres.maxConnections),
                  size: bytes(postgres.databaseSizeBytes),
                })
              : t('unavailable')
          }
          samples={samples.database}
          color={chartColor(0)}
          warn={dbWarn}
        />
        <Tile
          label={t('overview.redisMemory')}
          value={redis ? bytes(redis.usedMemoryBytes) : '–'}
          detail={
            redis
              ? `${
                  redis.maxMemoryBytes > 0
                    ? `${format.number(redis.usedMemoryBytes / redis.maxMemoryBytes, { style: 'percent', maximumFractionDigits: 0 })} / ${bytes(redis.maxMemoryBytes)}`
                    : t('overview.redisUnlimited')
                } · ${t('overview.redisMemoryDetail', { clients: num(redis.connectedClients), ops: num(redis.opsPerSecond) })}`
              : t('unavailable')
          }
          samples={samples.redisMemory}
          color={chartColor(1)}
          warn={memWarn}
        />
        <Tile
          label={t('overview.sockets')}
          value={realtime && realtime.instances > 0 ? num(realtime.sockets) : '–'}
          detail={
            realtime && realtime.instances > 0
              ? t('overview.socketsDetail', { instances: realtime.instances })
              : t('realtime.notReporting')
          }
          samples={samples.sockets}
          color={chartColor(2)}
        />
        <Tile
          label={t('overview.shopSessions')}
          value={waitingRoom ? num(waitingRoom.shopSessions) : '–'}
          detail={t('overview.shopSessionsDetail')}
          samples={samples.shoppers}
          color={chartColor(3)}
        />
        <Tile
          label={t('overview.seatLocks')}
          value={seatLocks ? num(seatLocks.total) : '–'}
          detail={t('overview.seatLocksDetail')}
          samples={samples.seatLocks}
          color={chartColor(4)}
        />
        <Tile
          label={t('overview.backlog')}
          value={
            queues ? num(queues.reduce((s, q) => s + q.waiting + q.active + q.delayed, 0)) : '–'
          }
          detail={t('overview.backlogDetail')}
          samples={samples.backlog}
          color={chartColor(5)}
          warn={failedTotal > 0}
        />
        <Tile
          label={t('redis.ops')}
          value={redis ? num(redis.opsPerSecond) : '–'}
          detail={
            redis && redis.hitRatio !== null
              ? `${t('redis.hitRatio')}: ${format.number(redis.hitRatio, { style: 'percent', maximumFractionDigits: 1 })}`
              : undefined
          }
          samples={samples.redisOps}
          color={chartColor(6)}
        />
      </section>

      <Section title={t('queues.title')} description={t('queues.description')}>
        {queues ? (
          <Table data-testid="queue-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t('queues.queue')}</TableHead>
                <TableHead className="text-right">{t('queues.waiting')}</TableHead>
                <TableHead className="text-right">{t('queues.active')}</TableHead>
                <TableHead className="text-right">{t('queues.delayed')}</TableHead>
                <TableHead className="text-right">{t('queues.failed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.map((q) => (
                <TableRow key={q.name}>
                  <TableCell>
                    {t.has(`queues.names.${q.name}`)
                      ? t(`queues.names.${q.name}` as 'queues.names.email')
                      : q.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{q.name}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{num(q.waiting)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(q.active)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(q.delayed)}</TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      q.failed > 0 && 'font-semibold text-destructive',
                    )}
                  >
                    {num(q.failed)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
        )}
      </Section>

      <Section title={t('failedJobs.title')}>
        {stats.failedJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('failedJobs.none')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('failedJobs.time')}</TableHead>
                <TableHead>{t('failedJobs.queue')}</TableHead>
                <TableHead>{t('failedJobs.job')}</TableHead>
                <TableHead>{t('failedJobs.reason')}</TableHead>
                <TableHead className="text-right">{t('failedJobs.attempts')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.failedJobs.map((job) => (
                <TableRow key={`${job.queue}-${job.id}`}>
                  <TableCell className="whitespace-nowrap">{when(job.failedAt)}</TableCell>
                  <TableCell>{job.queue}</TableCell>
                  <TableCell>{job.name}</TableCell>
                  <TableCell className="max-w-md whitespace-normal break-words text-xs">
                    {job.reason}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{job.attempts}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={t('waitingRoom.title')}>
          {!waitingRoom || waitingRoom.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('waitingRoom.none')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('waitingRoom.event')}</TableHead>
                  <TableHead className="text-right">{t('waitingRoom.waiting')}</TableHead>
                  <TableHead className="text-right">{t('waitingRoom.lobby')}</TableHead>
                  <TableHead className="text-right">{t('waitingRoom.active')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {waitingRoom.events.map((e) => (
                  <TableRow key={e.eventId}>
                    <TableCell className="max-w-48 truncate">{e.title}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(e.waiting)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(e.lobby)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(e.active)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
        <Section title={t('seatLocks.title')}>
          {!seatLocks || seatLocks.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('seatLocks.none')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('seatLocks.event')}</TableHead>
                  <TableHead className="text-right">{t('seatLocks.seats')}</TableHead>
                  <TableHead className="text-right">{t('seatLocks.standing')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {seatLocks.events.map((e) => (
                  <TableRow key={e.eventId}>
                    <TableCell className="max-w-48 truncate">{e.title}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(e.seats)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(e.standing)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={t('workers.title')} description={t('workers.leaderHint')}>
          {!workers || workers.live.length === 0 ? (
            <p className="text-sm text-destructive">{t('workers.none')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('workers.id')}</TableHead>
                  <TableHead>{t('workers.version')}</TableHead>
                  <TableHead>{t('workers.lastBeat')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.live.map((w) => (
                  <TableRow key={w.workerId}>
                    <TableCell className="max-w-56 truncate font-mono text-xs" title={w.workerId}>
                      {w.workerId}{' '}
                      {w.leader && <Badge variant="secondary">{t('workers.leader')}</Badge>}
                    </TableCell>
                    <TableCell>{w.version}</TableCell>
                    <TableCell className="whitespace-nowrap">{when(w.lastBeatAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {workers && workers.live.length > 0 && !workers.leaderId && (
            <p className="mt-2 text-sm text-destructive">{t('workers.noLeader')}</p>
          )}
        </Section>
        <Section title={t('realtime.title')}>
          {realtime && realtime.instances > 0 ? (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t('realtime.instances')}</dt>
                <dd className="text-xl font-semibold tabular-nums">{num(realtime.instances)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('realtime.sockets')}</dt>
                <dd className="text-xl font-semibold tabular-nums">{num(realtime.sockets)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t('realtime.notReporting')}</p>
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={t('postgres.title')}>
          {postgres ? (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t('postgres.version')}</dt>
                <dd>{postgres.version}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('postgres.connections')}</dt>
                <dd className="tabular-nums">
                  {num(postgres.connections)} / {num(postgres.maxConnections)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('postgres.size')}</dt>
                <dd>{bytes(postgres.databaseSizeBytes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('postgres.longestQuery')}</dt>
                <dd className="tabular-nums">
                  {t('postgres.seconds', {
                    value: format.number(postgres.longestQuerySeconds, {
                      maximumFractionDigits: 1,
                    }),
                  })}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
          )}
        </Section>
        <Section title={t('redis.title')}>
          {redis ? (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t('redis.version')}</dt>
                <dd>{redis.version}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('redis.memory')}</dt>
                <dd className={cn('tabular-nums', memWarn && 'font-semibold text-destructive')}>
                  {bytes(redis.usedMemoryBytes)}
                  {redis.maxMemoryBytes > 0 && ` / ${bytes(redis.maxMemoryBytes)}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('redis.clients')}</dt>
                <dd className="tabular-nums">{num(redis.connectedClients)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('redis.uptime')}</dt>
                <dd>{duration(redis.uptimeSeconds)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
          )}
        </Section>
      </div>

      <Section title={t('backlog.title')}>
        {backlog ? (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">{t('backlog.emailPending')}</dt>
              <dd className="text-xl font-semibold tabular-nums">{num(backlog.emailPending)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('backlog.emailFailed')}</dt>
              <dd
                className={cn(
                  'text-xl font-semibold tabular-nums',
                  backlog.emailFailed > 0 && 'text-destructive',
                )}
              >
                {num(backlog.emailFailed)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('backlog.openRefunds')}</dt>
              <dd className="text-xl font-semibold tabular-nums">{num(backlog.openRefunds)}</dd>
              <dd>
                <Link href="/admin/refunds" className="text-xs underline">
                  {t('backlog.refundsLink')}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('backlog.unmatchedBank')}</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {num(backlog.unmatchedBankTransactions)}
              </dd>
              <dd>
                <Link href="/admin/banking" className="text-xs underline">
                  {t('backlog.bankLink')}
                </Link>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
        )}
      </Section>

      <p className="text-xs text-muted-foreground">
        {metricsEnabled ? t('metrics.enabled') : t('metrics.disabled')}{' '}
        <Link href="/admin/settings/security" className="underline">
          {t('metrics.link')}
        </Link>
      </p>
    </div>
  );
}
