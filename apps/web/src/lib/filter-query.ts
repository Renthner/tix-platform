/**
 * Pure helpers of the auto-applying admin filter forms (`AutoSubmitForm`). No framework imports,
 * so they run under `node --test` as well.
 */

/** Query params a filter change must drop (filtering returns to the first page). */
export const FILTER_RESET_PARAMS = ['page'] as const;

/**
 * Builds the query exactly like a native GET submit would (entry order, repeated names kept),
 * but skips empty values and files and drops the page param.
 */
export function filterEntriesToParams(
  entries: Iterable<readonly [string, unknown]>,
  drop: readonly string[] = FILTER_RESET_PARAMS,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of entries) {
    if (typeof value !== 'string' || value === '' || drop.includes(name)) continue;
    params.append(name, value);
  }
  return params;
}

/** Order-independent form of a query (without the page param) for "did anything change?". */
export function canonicalQuery(
  query: string | URLSearchParams,
  drop: readonly string[] = FILTER_RESET_PARAMS,
): string {
  const params = new URLSearchParams(query);
  for (const name of drop) params.delete(name);
  const pairs = [...params.entries()].filter(([, v]) => v !== '');
  pairs.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  return new URLSearchParams(pairs).toString();
}

/**
 * Whether a date-like input value may be applied: empty (filter cleared) or complete with a
 * plausible four-digit year (typing the year produces `0002-…`, `0020-…` on the way).
 */
export function isApplicableDateValue(type: string, value: string): boolean {
  if (value === '') return true;
  const year = /^(\d{4,})-/.exec(value)?.[1];
  const plausibleYear = year !== undefined && Number(year) >= 1900 && Number(year) <= 9999;
  switch (type) {
    case 'date':
      return plausibleYear && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'month':
      return plausibleYear && /^\d{4}-\d{2}$/.test(value);
    case 'week':
      return plausibleYear && /^\d{4}-W\d{2}$/.test(value);
    case 'datetime-local':
      return plausibleYear && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
    case 'time':
      return /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
    default:
      return true;
  }
}

/** Input types that are applied after a typing pause (debounced) instead of on change. */
export const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'tel',
  'url',
  'number',
]);

/** Date-like input types (debounced, applied only with a complete value). */
export const DATE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
]);
