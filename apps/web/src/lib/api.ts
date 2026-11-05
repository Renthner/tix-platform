/** Error thrown by `apiFetch` for non-2xx responses (maps to `common.errors.<code>`). */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** JSON fetch for the shop APIs (same-origin, cookies included, no caching). */
export async function apiFetch<T>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...rest,
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as
    (T & { error?: { code: string; message: string; details?: Record<string, unknown> } }) | null;
  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? response.statusText,
      response.status,
      error?.details,
    );
  }
  return body as T;
}

/** Primitive error details (e.g. {max}, {category}) for the translated error message. */
export function errorValues(err: unknown): Record<string, string | number> {
  if (!(err instanceof ApiError) || !err.details) return {};
  return Object.fromEntries(
    Object.entries(err.details).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number',
    ),
  );
}

/**
 * Translated message of an API error (`common.errors.<CODE>`) with its details filled in;
 * unknown codes fall back to INTERNAL_ERROR. `tErr` = useTranslations('common.errors').
 */
export function errorMessage(tErr: { has: (key: never) => boolean }, err: unknown): string {
  const t = tErr as unknown as {
    has: (key: string) => boolean;
    (key: string, values?: Record<string, string | number>): string;
  };
  const code = errorCode(err);
  return t.has(code) ? t(code, errorValues(err)) : t('INTERNAL_ERROR');
}

export function errorCode(err: unknown): string {
  return err instanceof ApiError ? err.code : 'INTERNAL_ERROR';
}
