import { logger } from '@/server/logger';
import 'server-only';
import {
  DomainError,
  LOAD_TEST_HEADER,
  noteLoadTestBypass,
  readBodyText,
  verifyLoadTestToken,
  type LoadTestBypassBucket,
} from '@tix/core';
import { isDbBusyError, pgErrorCode } from '@tix/db';
import { rateLimit } from '@tix/redis';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from './core';
import { assertNotInMaintenance } from './maintenance-assert';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function apiError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  return NextResponse.json<ApiErrorBody>(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/** Transient database overload (lock / statement / pool timeout); the aborted transaction was rolled back, so a retry is expected to succeed. */
export function busyResponse() {
  const res = apiError('BUSY', 'The system is busy right now. Please try again in a moment.', 503);
  res.headers.set('retry-after', '2');
  return res;
}

/** Runs a route handler body and maps domain / validation errors to JSON responses. */
export async function handle(
  fn: () => Promise<Response>,
  options: { allowIncompleteRestore?: boolean } = {},
): Promise<Response> {
  try {
    await assertNotInMaintenance(options);
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) return apiError(err.code, err.message, err.status, err.details);
    if (err instanceof z.ZodError) {
      return apiError('VALIDATION_FAILED', 'Invalid request', 422, {
        issues: err.issues
          .slice(0, 20)
          .map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    // Errors thrown by redirect()/notFound() must propagate.
    if (err instanceof Error && 'digest' in err) throw err;
    if (isDbBusyError(err)) {
      // A statement timeout (57014) means a slow query, not just contention: keep it visible.
      (pgErrorCode(err) === '57014' ? logger.error : logger.warn).call(
        logger,
        { err },
        '[api] database busy',
      );
      return busyResponse();
    }
    const reqId = await headers()
      .then((h) => h.get('x-request-id') ?? undefined)
      .catch(() => undefined);
    logger.error({ err, reqId }, '[api] unhandled error');
    return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500);
  }
}

/**
 * CSRF defence in depth (on top of SameSite cookies) for every state-changing request:
 * browsers announce the origin of the caller (`Sec-Fetch-Site` / `Origin`); anything that is
 * not same-origin is rejected. Requests without either header (non-browser clients) pass –
 * they cannot ride on a victim's cookies.
 */
export function assertSameOrigin(request: Request): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const reject = () => {
    throw new DomainError('CSRF_REJECTED', 'Cross-site request rejected', 403);
  };
  const site = request.headers.get('sec-fetch-site');
  if (site) {
    if (site !== 'same-origin' && site !== 'none') reject();
    return;
  }
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') {
    if (origin === 'null') reject();
    return;
  }
  const allowed = new Set(
    [
      request.headers.get('x-forwarded-host'),
      request.headers.get('host'),
      process.env.APP_URL ? new URL(process.env.APP_URL).host : null,
    ].filter((h): h is string => Boolean(h)),
  );
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    reject();
  }
  if (!allowed.has(host)) reject();
}

/** Default byte cap for JSON request bodies (public routes only carry a few ids / small forms). */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export { readBodyText };

export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  options: { maxBytes?: number } = {},
): Promise<z.output<T>> {
  assertSameOrigin(request);
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }
  const text = await readBodyText(request, options.maxBytes ?? DEFAULT_MAX_BODY_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be JSON', 400);
  }
  return schema.parse(raw);
}

/**
 * Client address for rate limiting and audit. The only proxy in front of the app is the built-in
 * proxy of the image (docker/supervisor/proxy.mjs), which discards a client-supplied
 * X-Forwarded-For and always sends exactly one address (the peer it saw, or the visitor address
 * taken from a trusted proxy listed in TRUSTED_PROXIES) – so the right-most entry cannot be forged.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h
    .get('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  const ip = forwarded || h.get('x-real-ip');
  if (ip) return ip;
  // Safe fallback: all unknown clients share one rate-limit bucket (stricter, never bypassed).
  if (!warnedMissingIp) {
    warnedMissingIp = true;
    logger.warn(
      '[http] no client address (X-Forwarded-For / X-Real-IP missing); check the proxy setup',
    );
  }
  return '0.0.0.0';
}

let warnedMissingIp = false;

/** Throws HTTP 429 when the subject exceeded `max` requests in the window. */
export async function enforceRateLimit(
  bucket: string,
  subject: string,
  max: number,
  windowMs: number,
): Promise<void> {
  const core = getCore();
  const safeSubject = subject.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120) || 'unknown';
  const result = await rateLimit(core.redis, core.keys, bucket, safeSubject, max, windowMs);
  if (!result.allowed) {
    throw new DomainError('RATE_LIMITED', 'Too many requests. Please slow down.', 429, {
      retryAfterMs: result.retryAfterMs,
    });
  }
}

/**
 * Per-IP THROUGHPUT limit that a sanctioned load test may skip: requests carrying the valid
 * `X-Tix-Loadtest` token while the time-limited load test mode is on (Admin -> System). The header
 * is ignored otherwise. Only the buckets in `LOAD_TEST_BYPASS_BUCKETS` are allowed (compile-time
 * and unit-test enforced); never use this for authentication, per-session, per-e-mail or per-code
 * limits.
 */
export async function enforceIpThroughputLimit(
  bucket: LoadTestBypassBucket,
  max: number,
  windowMs: number,
): Promise<void> {
  const presented = (await headers()).get(LOAD_TEST_HEADER);
  if (presented) {
    const core = getCore();
    if (await verifyLoadTestToken(core, presented)) {
      noteLoadTestBypass(core);
      return;
    }
  }
  await enforceRateLimit(bucket, await clientIp(), max, windowMs);
}

export const uuidParam = z.uuid();

/** Content locale requested by shop clients (`?locale=de`); unknown values fall back to the default. */
export function localeParam(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get('locale');
  return value && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(value) ? value : undefined;
}
