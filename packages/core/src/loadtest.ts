import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { auditLogs } from '@tix/db';
import type { CoreContext } from './context';
import { DomainError } from './context';
import { coreLog } from './log';

/**
 * Load test mode: a time-limited, auditable switch that lets a load generator carrying the
 * header `X-Tix-Loadtest: <token>` skip the PER-IP throughput limits of the application (see
 * `LOAD_TEST_BYPASS_BUCKETS`). Nothing else changes: authentication limits, per-session /
 * per-e-mail / per-code limits, order limits, seat-lock correctness and CSRF checks stay as they
 * are. The state lives in Redis only (TTL), so a lost Redis means "off" (fail closed).
 *
 * Only the SHA-256 of the random token is stored; the token itself is shown once at enable time
 * and never logged or audited.
 */

export const LOAD_TEST_HEADER = 'x-tix-loadtest';
export const LOAD_TEST_MIN_MINUTES = 5;
export const LOAD_TEST_MAX_MINUTES = 240;
export const LOAD_TEST_DEFAULT_MINUTES = 60;

/**
 * The ONLY rate-limit buckets a sanctioned load test may skip: per-IP throughput limits of the
 * shop. Everything that protects secrets (VIP / discount codes), mail flooding (waiting list),
 * accounts, admin / scanner authentication, webhooks or tickets is deliberately absent. A unit
 * test pins the call sites to this list.
 */
export const LOAD_TEST_BYPASS_BUCKETS = [
  'shop-ip',
  'checkout-ip',
  'enter-ip',
  'realtime-token-ip',
] as const;
export type LoadTestBypassBucket = (typeof LOAD_TEST_BYPASS_BUCKETS)[number];

type Ctx = Pick<CoreContext, 'redis' | 'keys'>;
type AuditCtx = Ctx & Pick<CoreContext, 'db'>;

interface StoredState {
  runId: string;
  tokenHash: string;
  startedAt: number;
  expiresAt: number;
  durationMinutes: number;
  enabledBy: string;
}

export interface LoadTestStatus {
  active: boolean;
  runId?: string;
  startedAt?: Date;
  expiresAt?: Date;
  enabledBy?: string;
  /** Requests that skipped a per-IP limit so far (this run). */
  bypassedRequests?: number;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function parseState(raw: string | null): StoredState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<StoredState>;
    if (
      typeof s.runId === 'string' &&
      typeof s.tokenHash === 'string' &&
      typeof s.expiresAt === 'number' &&
      typeof s.startedAt === 'number'
    ) {
      return s as StoredState;
    }
  } catch {
    /* corrupt record = off */
  }
  return null;
}

// Hot path: the header is only evaluated when present, and the state is cached for a second per
// process (a disable therefore takes effect within about a second everywhere).
const CACHE_MS = 1000;
let cache: { at: number; state: StoredState | null } | null = null;

async function readState(ctx: Ctx, fresh = false): Promise<StoredState | null> {
  const t = Date.now();
  if (!fresh && cache && t - cache.at < CACHE_MS) return cache.state;
  let state: StoredState | null = null;
  try {
    state = parseState(await ctx.redis.get(ctx.keys.loadTestState()));
  } catch {
    state = null; // fail closed
  }
  cache = { at: t, state };
  return state;
}

/** Test hook: forgets the per-process cache. */
export function resetLoadTestCache(): void {
  cache = null;
}

/** Constant-time check of a presented token against the active run. False whenever the mode is off. */
export async function verifyLoadTestToken(
  ctx: Ctx,
  presented: string | null | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!presented || presented.length > 256) return false;
  const state = await readState(ctx);
  if (!state || state.expiresAt <= now) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(state.tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Counts a skipped per-IP limit (only while the mode is on). Never throws. */
export function noteLoadTestBypass(ctx: Ctx): void {
  const key = ctx.keys.loadTestBypassed();
  ctx.redis
    .incr(key)
    // INCR re-creates a missing key without a TTL (a request right after the run ended): never
    // leave an immortal counter behind.
    .then((n) => (n === 1 ? ctx.redis.expire(key, BYPASS_COUNTER_TTL_SECONDS) : undefined))
    .catch(() => undefined);
}

/** Safety TTL of a counter that INCR had to re-create. */
export const BYPASS_COUNTER_TTL_SECONDS = 3600;

export async function getLoadTestStatus(ctx: Ctx, now = Date.now()): Promise<LoadTestStatus> {
  const state = await readState(ctx, true);
  if (!state || state.expiresAt <= now) return { active: false };
  let bypassed = 0;
  try {
    bypassed = Number((await ctx.redis.get(ctx.keys.loadTestBypassed())) ?? 0);
  } catch {
    /* informational */
  }
  return {
    active: true,
    runId: state.runId,
    startedAt: new Date(state.startedAt),
    expiresAt: new Date(state.expiresAt),
    enabledBy: state.enabledBy,
    bypassedRequests: bypassed,
  };
}

export function clampLoadTestMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return LOAD_TEST_DEFAULT_MINUTES;
  return Math.min(LOAD_TEST_MAX_MINUTES, Math.max(LOAD_TEST_MIN_MINUTES, Math.round(minutes)));
}

/**
 * Starts a run (SUPER_ADMIN + re-authentication are checked by the caller). Fails with 409 while
 * another run is active. Returns the token once.
 */
export async function enableLoadTest(
  ctx: AuditCtx,
  params: { userId: string; durationMinutes: number; ipAddress?: string | null },
): Promise<{ token: string; runId: string; expiresAt: Date; durationMinutes: number }> {
  const durationMinutes = clampLoadTestMinutes(params.durationMinutes);
  const existing = await getLoadTestStatus(ctx);
  if (existing.active) {
    throw new DomainError('LOADTEST_ACTIVE', 'A load test is already active', 409);
  }
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const state: StoredState = {
    runId: randomUUID(),
    tokenHash: hashToken(token),
    startedAt: now,
    expiresAt: now + durationMinutes * 60_000,
    durationMinutes,
    enabledBy: params.userId,
  };
  // Keep the record one hour past expiry so the exactly-once "expired" audit entry can be written.
  const ttlSeconds = durationMinutes * 60 + 3600;
  const set = await ctx.redis.set(
    ctx.keys.loadTestState(),
    JSON.stringify(state),
    'EX',
    ttlSeconds,
    'NX',
  );
  if (set !== 'OK') {
    // A stale (expired, not yet reaped) record: close it first, then retry once.
    await reapExpiredLoadTest(ctx);
    const retry = await ctx.redis.set(
      ctx.keys.loadTestState(),
      JSON.stringify(state),
      'EX',
      ttlSeconds,
      'NX',
    );
    if (retry !== 'OK') {
      throw new DomainError('LOADTEST_ACTIVE', 'A load test is already active', 409);
    }
  }
  await ctx.redis.set(ctx.keys.loadTestBypassed(), 0, 'EX', ttlSeconds);
  cache = null;
  // The mode must never be active without its audit entry (and without a token holder): when the
  // entry cannot be written the activation is rolled back and the caller gets the error.
  try {
    await ctx.db.insert(auditLogs).values({
      actorType: 'ADMIN',
      actorUserId: params.userId,
      action: 'loadtest.enable',
      entityType: 'loadtest',
      entityId: state.runId,
      changes: null,
      metadata: {
        runId: state.runId,
        durationMinutes,
        expiresAt: new Date(state.expiresAt).toISOString(),
      },
      ipAddress: params.ipAddress ?? null,
    });
  } catch (err) {
    await ctx.redis
      .del(ctx.keys.loadTestState(), ctx.keys.loadTestBypassed())
      .catch(() => undefined);
    cache = null;
    throw err;
  }
  coreLog.warn({ runId: state.runId, durationMinutes }, '[loadtest] mode enabled');
  return { token, runId: state.runId, expiresAt: new Date(state.expiresAt), durationMinutes };
}

/** Ends the run exactly once (disable button or expiry) and writes the audit entry. */
async function finish(
  ctx: AuditCtx,
  state: StoredState,
  how: 'disable' | 'expire',
  actor: { userId: string | null; ipAddress?: string | null },
): Promise<boolean> {
  const first = await ctx.redis.set(
    ctx.keys.loadTestFinished(state.runId),
    how,
    'EX',
    7 * 86400,
    'NX',
  );
  if (first !== 'OK') {
    // Ended before (audit written): make sure the state is really gone (an earlier call may have
    // died between the audit entry and the delete).
    await ctx.redis
      .del(ctx.keys.loadTestState(), ctx.keys.loadTestBypassed())
      .catch(() => undefined);
    cache = null;
    return false;
  }
  let bypassed = 0;
  try {
    bypassed = Number((await ctx.redis.get(ctx.keys.loadTestBypassed())) ?? 0);
  } catch {
    /* informational */
  }
  // Audit entry FIRST: when it cannot be written the marker is released again and the state stays
  // (a retry ends the run and writes the entry); the entry is never lost to a state change.
  try {
    await ctx.db.insert(auditLogs).values({
      actorType: how === 'disable' ? 'ADMIN' : 'SYSTEM',
      actorUserId: how === 'disable' ? actor.userId : null,
      action: how === 'disable' ? 'loadtest.disable' : 'loadtest.expire',
      entityType: 'loadtest',
      entityId: state.runId,
      changes: null,
      metadata: {
        runId: state.runId,
        bypassedRequests: bypassed,
        startedAt: new Date(state.startedAt).toISOString(),
        expiresAt: new Date(state.expiresAt).toISOString(),
      },
      ipAddress: actor.ipAddress ?? null,
    });
  } catch (err) {
    await ctx.redis.del(ctx.keys.loadTestFinished(state.runId)).catch(() => undefined);
    throw err;
  }
  await ctx.redis.del(ctx.keys.loadTestState(), ctx.keys.loadTestBypassed());
  cache = null;
  coreLog.warn({ runId: state.runId, how, bypassed }, '[loadtest] mode ended');
  return true;
}

/** Disable button. Idempotent: returns false when no run is active. */
export async function disableLoadTest(
  ctx: AuditCtx,
  params: { userId: string; ipAddress?: string | null },
): Promise<boolean> {
  const state = await readState(ctx, true);
  if (!state) return false;
  // An already expired run is closed as "expire", not as a manual disable.
  const how = state.expiresAt <= Date.now() ? 'expire' : 'disable';
  return finish(ctx, state, how, { userId: params.userId, ipAddress: params.ipAddress });
}

/** Writes the "expired" audit entry for a run whose time is up. Called by the worker loop and the admin page. */
export async function reapExpiredLoadTest(ctx: AuditCtx, now = Date.now()): Promise<boolean> {
  const state = await readState(ctx, true);
  if (!state || state.expiresAt > now) return false;
  return finish(ctx, state, 'expire', { userId: null });
}
