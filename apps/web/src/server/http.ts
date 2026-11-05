import 'server-only';
import { DomainError } from '@tix/core';
import { rateLimit } from '@tix/redis';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from './core';

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

/** Runs a route handler body and maps domain / validation errors to JSON responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
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
    console.error('[api] unhandled error', err);
    return apiError('INTERNAL_ERROR', 'Something went wrong. Please try again.', 500);
  }
}

export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be JSON', 400);
  }
  return schema.parse(raw);
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || h.get('x-real-ip') || '0.0.0.0';
}

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

export const uuidParam = z.uuid();
