'use client';

import { useTranslations } from 'next-intl';

/** Shared types and the tiny fetch helper of the scanner admin components. */

/** Localised message for an API error code (unknown codes fall back to the generic text). */
export function useErrorMessage() {
  const te = useTranslations('scanners.errors');
  return (code: string) => (te.has(code as 'generic') ? te(code as 'generic') : te('generic'));
}

export interface ScannerEventOption {
  id: string;
  title: string;
  startsAt: string;
  entrances: { id: string; name: string; code: string }[];
}

export interface DeviceAssignmentValue {
  eventId: string;
  entranceId: string | null;
  allowCheckOut: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string };

/** JSON request against an admin API route; errors are reduced to their machine-readable code. */
export async function adminRequest<T = Record<string, unknown>>(
  url: string,
  init: { method: string; json?: unknown; form?: FormData },
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.json !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as
      (T & { error?: { code?: string } }) | null;
    if (!response.ok) return { ok: false, code: body?.error?.code ?? 'generic' };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, code: 'generic' };
  }
}
