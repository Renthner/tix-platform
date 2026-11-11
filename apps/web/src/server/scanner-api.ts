import 'server-only';
import { authenticateDevice, DomainError, type ScannerDeviceAuth } from '@tix/core';
import { z } from 'zod';
import { getCore } from './core';
import { clientIp, enforceRateLimit } from './http';
import { assertNotInMaintenance } from './maintenance-assert';

/**
 * Helper for the Android device API (`/api/scanner/v1/*`). Deliberately independent of the
 * browser infrastructure: Bearer token only (no cookies, so no CSRF/Origin check), own JSON body
 * reader with a hard size limit and one uniform error shape `{ error: <code>, message }`.
 * `proxy.ts` does not run for `/api`, so the maintenance check happens here (503 JSON with
 * `Retry-After` = the app goes offline and retries later).
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function scannerJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function scannerError(
  code: string,
  message: string,
  status: number,
  extra: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  return scannerJson(
    { error: code, message, ...(extra.details ? { details: extra.details } : {}) },
    status,
    extra.headers,
  );
}

function errorResponse(err: unknown): Response {
  if (err instanceof DomainError) {
    const headers: Record<string, string> = {};
    if (err.status === 503) headers['retry-after'] = '30';
    if (err.code === 'RATE_LIMITED') {
      const ms = Number(err.details?.retryAfterMs ?? 1_000);
      headers['retry-after'] = String(Math.max(1, Math.ceil(ms / 1_000)));
    }
    if (err.status === 401) headers['www-authenticate'] = 'Bearer';
    return scannerError(err.code, err.message, err.status, { details: err.details, headers });
  }
  if (err instanceof z.ZodError) {
    return scannerError('VALIDATION_FAILED', 'Invalid request', 422, {
      details: {
        issues: err.issues
          .slice(0, 20)
          .map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  console.error('[scanner-api] unhandled error', err);
  return scannerError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500);
}

export interface ScannerRouteContext {
  device: ScannerDeviceAuth;
}

interface RouteOptions {
  /** Rate-limit bucket name (one per route). */
  route: string;
  /** Requests per minute per device. */
  perMinute: number;
}

const AUTH_FAIL_BUCKET = 'scanner-authfail';
const AUTH_FAIL_LIMIT = 30;

/** Rejects (429) clients that already used up their failed-authentication budget; does not charge. */
async function assertAuthFailBudget(ip: string): Promise<void> {
  const core = getCore();
  const subject = ip.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120) || 'unknown';
  const key = core.keys.rateLimit(AUTH_FAIL_BUCKET, subject);
  const used = Number((await core.redis.get(key)) ?? 0);
  if (used >= AUTH_FAIL_LIMIT) {
    const ttl = await core.redis.pttl(key);
    throw new DomainError('RATE_LIMITED', 'Too many failed attempts. Please slow down.', 429, {
      retryAfterMs: Math.max(1_000, ttl),
    });
  }
}

/** Authenticated device endpoint. */
export async function deviceRoute(
  request: Request,
  fn: (ctx: ScannerRouteContext) => Promise<Response>,
  options: RouteOptions,
): Promise<Response> {
  try {
    await assertNotInMaintenance();
    // Budget of failed authentications is checked BEFORE the token lookup (429 once exhausted).
    const ip = await clientIp();
    await assertAuthFailBudget(ip);
    let device: ScannerDeviceAuth;
    try {
      device = await authenticateDevice(getCore(), request.headers.get('authorization'), {
        appVersion: request.headers.get('x-scanner-app-version'),
      });
    } catch (err) {
      // Failed authentications are charged to the client address (token guessing: 30 per minute).
      if (err instanceof DomainError && err.status === 401) {
        await enforceRateLimit(AUTH_FAIL_BUCKET, ip, AUTH_FAIL_LIMIT, 60_000);
      }
      throw err;
    }
    // One bucket per route, matching the limits documented in docs/SCANNER.md.
    await enforceRateLimit(`scanner:${options.route}`, device.id, options.perMinute, 60_000);
    return await fn({ device });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Unauthenticated endpoint (pairing, signed download link), rate limited by client IP. */
export async function publicScannerRoute(
  bucket: string,
  perMinute: number,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    await assertNotInMaintenance();
    await enforceRateLimit(bucket, await clientIp(), perMinute, 60_000);
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}

/** Reads a JSON body with a byte limit (not trusting Content-Length) and validates it. */
export async function readJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes: number,
): Promise<z.output<T>> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw tooLarge(maxBytes);
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError('INVALID_JSON', 'Request body must be JSON', 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be JSON', 400);
  }
  return schema.parse(raw);
}

function tooLarge(maxBytes: number): DomainError {
  return new DomainError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`, 413);
}

/** Query string as plain object for zod. */
export function queryOf(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}
