import type { SystemStats } from './system';

/**
 * Prometheus text exposition format (version 0.0.4) of the system status, hand-written so no
 * client library is needed. Label values are escaped; events are identified by id only (titles
 * can contain anything and change).
 */

const escapeLabel = (v: string) =>
  v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  return String(v);
}

class Writer {
  private readonly lines: string[] = [];
  private readonly declared = new Set<string>();

  metric(
    name: string,
    help: string,
    type: 'gauge' | 'counter',
    value: number,
    labels: Record<string, string> = {},
  ): void {
    if (!this.declared.has(name)) {
      this.declared.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
    this.lines.push(`${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${formatValue(value)}`);
  }

  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

export function renderPrometheus(stats: SystemStats): string {
  const w = new Writer();
  const g = (name: string, help: string, value: number, labels?: Record<string, string>) =>
    w.metric(name, help, 'gauge', value, labels);

  g('tix_build_info', 'Application version (value is always 1).', 1, {
    version: stats.app.version,
  });
  g('tix_process_uptime_seconds', 'Uptime of the web process.', stats.app.uptimeSeconds);
  g('tix_process_resident_memory_bytes', 'Resident memory of the web process.', stats.app.rssBytes);
  g('tix_process_heap_used_bytes', 'Used V8 heap of the web process.', stats.app.heapUsedBytes);
  const c = stats.shopCache;
  g('tix_shop_cache_entries', 'Entries in the shop data cache of this web process.', c.entries);
  g(
    'tix_shop_cache_synced',
    '1 when the shop data cache is subscribed to cross-instance invalidations.',
    c.state === 'synced' ? 1 : 0,
  );
  for (const [result, value] of [
    ['hit', c.hits],
    ['miss', c.misses],
    ['coalesced', c.coalesced],
    ['bypass', c.bypasses],
    ['discarded', c.discarded],
  ] as const) {
    w.metric(
      'tix_shop_cache_lookups_total',
      'Shop data cache lookups by result (since process start).',
      'counter',
      value,
      { result },
    );
  }
  w.metric(
    'tix_shop_cache_invalidations_total',
    'Tag invalidations applied (local and received from other instances).',
    'counter',
    c.invalidations,
  );
  w.metric(
    'tix_shop_cache_flushes_total',
    'Full flushes of the shop data cache.',
    'counter',
    c.flushes,
  );
  for (const block of stats.errors) {
    g('tix_collect_error', '1 when a status block could not be collected.', 1, { block });
  }

  if (stats.postgres) {
    const p = stats.postgres;
    g('tix_postgres_connections', 'Open connections to the database.', p.connections);
    g('tix_postgres_max_connections', 'max_connections of the server.', p.maxConnections);
    g('tix_postgres_database_size_bytes', 'Size of the database.', p.databaseSizeBytes);
    g(
      'tix_postgres_longest_query_seconds',
      'Age of the longest running active query.',
      p.longestQuerySeconds,
    );
  }
  if (stats.redis) {
    const r = stats.redis;
    g('tix_redis_used_memory_bytes', 'Memory used by Redis.', r.usedMemoryBytes);
    g('tix_redis_max_memory_bytes', 'Configured maxmemory (0 = unlimited).', r.maxMemoryBytes);
    g('tix_redis_connected_clients', 'Clients connected to Redis.', r.connectedClients);
    g('tix_redis_ops_per_second', 'Instantaneous Redis operations per second.', r.opsPerSecond);
    if (r.hitRatio !== null) {
      g('tix_redis_keyspace_hit_ratio', 'Keyspace hits / (hits + misses).', r.hitRatio);
    }
  }
  for (const q of stats.queues ?? []) {
    for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
      g('tix_queue_jobs', 'BullMQ jobs per queue and state.', q[state], { queue: q.name, state });
    }
  }
  if (stats.waitingRoom) {
    g(
      'tix_shop_sessions',
      'Shoppers active in the last 45 seconds.',
      stats.waitingRoom.shopSessions,
    );
    for (const e of stats.waitingRoom.events) {
      for (const state of ['waiting', 'lobby', 'active'] as const) {
        g('tix_waiting_room_sessions', 'Waiting room sessions per event.', e[state], {
          event_id: e.eventId,
          state,
        });
      }
    }
  }
  if (stats.seatLocks) {
    g('tix_seat_locks', 'Seats and standing spots held in carts.', stats.seatLocks.total);
    for (const e of stats.seatLocks.events) {
      g('tix_seat_locks_by_event', 'Cart holds per event and kind.', e.seats, {
        event_id: e.eventId,
        kind: 'seat',
      });
      g('tix_seat_locks_by_event', 'Cart holds per event and kind.', e.standing, {
        event_id: e.eventId,
        kind: 'standing',
      });
    }
  }
  if (stats.realtime) {
    g(
      'tix_realtime_instances',
      'Realtime gateway instances reporting a heartbeat.',
      stats.realtime.instances,
    );
    g(
      'tix_realtime_sockets',
      'Connected Socket.io clients (all instances).',
      stats.realtime.sockets,
    );
  }
  if (stats.workers) {
    g('tix_workers', 'Worker processes with a recent heartbeat.', stats.workers.live.length);
    g(
      'tix_worker_leader_present',
      '1 when a worker holds the loop lease (lock sweeper, waiting room ticker).',
      stats.workers.leaderId ? 1 : 0,
    );
  }
  if (stats.backlog) {
    g('tix_email_pending', 'E-mails queued or being sent.', stats.backlog.emailPending);
    g('tix_email_failed', 'E-mails that failed to send.', stats.backlog.emailFailed);
    g(
      'tix_refunds_open',
      'Open refunds (manual to-dos and failed automatic ones).',
      stats.backlog.openRefunds,
    );
    g(
      'tix_bank_transactions_unmatched',
      'Bank transactions waiting for an assignment.',
      stats.backlog.unmatchedBankTransactions,
    );
  }
  return w.toString();
}
