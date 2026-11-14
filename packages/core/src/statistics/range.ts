import {
  MAX_STATS_EVENTS,
  MAX_STATS_RANGE_DAYS,
  PAYMENT_METHODS,
  SALES_CHANNELS,
  STATS_RANGE_PRESETS,
  type PaymentMethod,
  type SalesChannel,
  type StatsRangePreset,
} from '@tix/shared';
import { wallMs, wallToInstant } from '../zoned-time';

/**
 * Pure helpers of the sales statistics: date range presets, bucket interval, previous period and
 * URL filter parsing. All dates are local calendar days (`YYYY-MM-DD`) in the shop time zone
 * (setting `general.defaultTimeZone`); the instants of the window are derived with
 * `windowInstants` so a day is 23 / 25 hours long on a DST switch.
 */

export const STATS_INTERVALS = ['hour', 'day', 'week', 'month'] as const;
export type StatsInterval = (typeof STATS_INTERVALS)[number];

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → UTC midnight in ms (null when it is not a real calendar date). */
export function parseIsoDate(value: string | undefined | null): number | null {
  const m = value ? DATE_RE.exec(value) : null;
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    return null;
  }
  return ms;
}

export function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The local calendar day of `now` in `timeZone`. */
export function todayInZone(now: Date, timeZone: string): string {
  return formatIsoDate(Math.floor(wallMs(now, timeZone) / DAY_MS) * DAY_MS);
}

export interface DateRange {
  from: string;
  to: string;
}

/** Number of calendar days of an inclusive range. */
export function rangeDays(range: DateRange): number {
  return Math.round((parseIsoDate(range.to)! - parseIsoDate(range.from)!) / DAY_MS) + 1;
}

/**
 * Resolves a preset (or a custom `from`/`to`) to an inclusive local date range. Invalid or
 * missing custom dates fall back to the last 30 days; swapped bounds are put in order.
 */
export function resolveRange(
  input: {
    preset?: StatsRangePreset | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
  now: Date,
  timeZone: string,
): DateRange & { preset: StatsRangePreset } {
  const today = parseIsoDate(todayInZone(now, timeZone))!;
  const last = (days: number) => ({
    from: formatIsoDate(today - (days - 1) * DAY_MS),
    to: formatIsoDate(today),
  });
  const preset = input.preset ?? '30d';
  if (preset === 'today') return { preset, ...last(1) };
  if (preset === '7d') return { preset, ...last(7) };
  if (preset === '30d') return { preset, ...last(30) };
  if (preset === 'year') {
    return {
      preset,
      from: `${new Date(today).getUTCFullYear()}-01-01`,
      to: formatIsoDate(today),
    };
  }
  let from = parseIsoDate(input.from);
  let to = parseIsoDate(input.to);
  if (from === null || to === null) return { preset: '30d', ...last(30) };
  if (from > to) [from, to] = [to, from];
  if ((to - from) / DAY_MS + 1 > MAX_STATS_RANGE_DAYS)
    from = to - (MAX_STATS_RANGE_DAYS - 1) * DAY_MS;
  return { preset: 'custom', from: formatIsoDate(from), to: formatIsoDate(to) };
}

/** Bucket size of the time series: hours up to 2 days, days up to ~3 months, weeks up to ~13 months. */
export function chooseInterval(days: number): StatsInterval {
  if (days <= 2) return 'hour';
  if (days <= 92) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

/** The period of the same length that ends the day before `range` starts. */
export function previousPeriod(range: DateRange): DateRange {
  const days = rangeDays(range);
  const to = parseIsoDate(range.from)! - DAY_MS;
  return { from: formatIsoDate(to - (days - 1) * DAY_MS), to: formatIsoDate(to) };
}

/** Half-open instant window `[start, end)` covering the local days `from … to` in `timeZone`. */
export function windowInstants(range: DateRange, timeZone: string): { start: Date; end: Date } {
  return {
    start: wallToInstant(parseIsoDate(range.from)!, timeZone),
    end: wallToInstant(parseIsoDate(range.to)! + DAY_MS, timeZone),
  };
}

// ─── URL filter ──────────────────────────────────────────────────────────────

export interface StatisticsFilter {
  preset: StatsRangePreset;
  from?: string | undefined;
  to?: string | undefined;
  eventIds: string[];
  channels: SalesChannel[];
  methods: PaymentMethod[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = Record<string, string | string[] | undefined>;

function many(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Filter from URL search params (`range`, `from`, `to`, repeated `event`, `channel`, `method`).
 * Unknown values are dropped silently so a stale link still opens.
 */
export function parseStatisticsParams(params: Params): StatisticsFilter {
  const raw = Array.isArray(params.range) ? params.range[0] : params.range;
  const preset = (STATS_RANGE_PRESETS as readonly string[]).includes(raw ?? '')
    ? (raw as StatsRangePreset)
    : '30d';
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return {
    preset,
    from: one(params.from),
    to: one(params.to),
    eventIds: [
      ...new Set(
        many(params.event)
          .filter((id) => UUID_RE.test(id))
          .map((id) => id.toLowerCase()),
      ),
    ].slice(0, MAX_STATS_EVENTS),
    channels: [...new Set(many(params.channel))].filter((c): c is SalesChannel =>
      (SALES_CHANNELS as readonly string[]).includes(c),
    ),
    methods: [...new Set(many(params.method))].filter((m): m is PaymentMethod =>
      (PAYMENT_METHODS as readonly string[]).includes(m),
    ),
  };
}

/** Inverse of `parseStatisticsParams` (stable order: used as link and cache key). */
export function statisticsFilterToParams(filter: StatisticsFilter): URLSearchParams {
  const p = new URLSearchParams();
  p.set('range', filter.preset);
  if (filter.preset === 'custom') {
    if (filter.from) p.set('from', filter.from);
    if (filter.to) p.set('to', filter.to);
  }
  for (const id of [...filter.eventIds].sort()) p.append('event', id);
  for (const c of [...filter.channels].sort()) p.append('channel', c);
  for (const m of [...filter.methods].sort()) p.append('method', m);
  return p;
}
