/**
 * Helpers shared by the paged admin lists (orders, customers, media, scan log, events): URL query
 * building and parsing of `page` / `pageSize` parameters. Pure, so it is unit-testable.
 */

export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export type QueryValue = string | number | boolean | null | undefined;

/**
 * `<pathname>?<query>` from `params`, with `overrides` applied on top. Empty values (undefined, null,
 * '', false) are dropped; `true` becomes `1`. Keys are emitted in insertion order, so the result is
 * deterministic.
 */
export function buildQuery(
  pathname: string,
  params: Record<string, QueryValue>,
  overrides: Record<string, QueryValue> = {},
): string {
  const merged = { ...params, ...overrides };
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    usp.set(key, value === true ? '1' : String(value));
  }
  const s = usp.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/** 1-based page number from a raw query value; anything invalid falls back to 1. */
export function parsePage(raw: string | undefined | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Page size from a raw query value, limited to the allowed sizes. */
export function parsePageSize(
  raw: string | undefined | null,
  allowed: readonly number[] = DEFAULT_PAGE_SIZES,
  fallback: number = DEFAULT_PAGE_SIZE,
): number {
  const n = Number.parseInt(raw ?? '', 10);
  return allowed.includes(n) ? n : fallback;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}
