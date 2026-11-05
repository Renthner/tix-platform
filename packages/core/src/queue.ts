import { randomUUID } from 'node:crypto';
import { accessCodeRedemptions, accessCodes } from '@tix/db';
import { signToken, verifyToken } from '@tix/shared/server';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { DomainError, type CoreContext } from './context';
import {
  ACTIVE_WINDOW_MS,
  computeSaleState,
  effectiveQueueConfig,
  saleOpensAt,
  type EffectiveQueueConfig,
  type EventRow,
  type SaleState,
} from './events';

/**
 * Virtual waiting room & access control for the shop of one event.
 *
 * Modes (per event or global):
 *  OFF                        everyone enters directly
 *  AUTO_THRESHOLD             direct entry while active shoppers < threshold, else queue
 *  SCHEDULED_PRE_REGISTRATION lobby before sale start, draw (FIFO or random) at T-0, batches
 *  VIP_CODE_ONLY              only valid access code holders may enter
 *  HYBRID                     everyone queues; valid access codes skip the queue
 * Independently of the mode, the presale window (presale start … public sale start) is open
 * to code holders with presale permission only.
 */

export const PASS_TOKEN_TYPE = 'qp';

export interface PassClaims {
  sid: string;
  eid: string;
  jti: string;
  /** Access code used (for per-code ticket limits at checkout). */
  cid?: string;
}

export type AccessDecision =
  | { status: 'GRANTED'; passToken: string; passExpiresAt: number }
  | {
      status: 'QUEUED';
      number: number;
      position: number;
      waiting: number;
      estimatedWaitSeconds: number;
      paused: boolean;
    }
  | { status: 'ADMITTED'; claimBefore: number }
  | { status: 'LOBBY'; saleOpensAt: string }
  | { status: 'CODE_REQUIRED'; reason: 'PRESALE' | 'VIP_ONLY' }
  | { status: 'NOT_STARTED'; saleOpensAt: string | null; lobbyOpensAt: string | null }
  | { status: 'CLOSED'; reason: SaleState };

function claimWindowMs(config: EffectiveQueueConfig): number {
  // Admitted visitors must claim their slot within one admission cycle plus a grace minute.
  return Math.max(60_000, config.admissionIntervalSeconds * 1000 * 2);
}

/** Validates a pass cookie: signature, expiry, subject and that it was not revoked. */
export async function verifyPass(
  ctx: CoreContext,
  eventId: string,
  sessionId: string,
  token: string | undefined,
): Promise<PassClaims | null> {
  const claims = verifyToken<PassClaims & Record<string, unknown>>(
    token,
    PASS_TOKEN_TYPE,
    ctx.sessionSecret,
  );
  if (!claims || claims.eid !== eventId || claims.sid !== sessionId) return null;
  const current = await ctx.queue.passId(eventId, sessionId);
  return current === claims.jti ? claims : null;
}

async function issuePass(
  ctx: CoreContext,
  event: EventRow,
  sessionId: string,
  config: EffectiveQueueConfig,
  jti: string,
): Promise<Extract<AccessDecision, { status: 'GRANTED' }>> {
  const codeId = await ctx.redis.get(ctx.keys.queueAccessCode(event.id, sessionId));
  const claims: PassClaims = {
    sid: sessionId,
    eid: event.id,
    jti,
    ...(codeId ? { cid: codeId } : {}),
  };
  return {
    status: 'GRANTED',
    passToken: signToken(
      PASS_TOKEN_TYPE,
      claims as unknown as Record<string, unknown>,
      config.passTokenTtlSeconds,
      ctx.sessionSecret,
    ),
    passExpiresAt: Date.now() + config.passTokenTtlSeconds * 1000,
  };
}

interface CodeState {
  hasCode: boolean;
  presale: boolean;
  bypass: boolean;
}

async function sessionCode(
  ctx: CoreContext,
  eventId: string,
  sessionId: string,
): Promise<CodeState> {
  const codeId = await ctx.redis.get(ctx.keys.queueAccessCode(eventId, sessionId));
  if (!codeId) return { hasCode: false, presale: false, bypass: false };
  const [code] = await ctx.db.select().from(accessCodes).where(eq(accessCodes.id, codeId));
  if (!code || !code.isActive) return { hasCode: false, presale: false, bypass: false };
  return { hasCode: true, presale: code.grantsPresaleAccess, bypass: code.bypassesQueue };
}

/**
 * Decides how a visitor may enter the shop of an event and, when possible, grants the
 * QueuePassToken right away. Safe to call repeatedly (idempotent per session).
 */
export async function enterShop(
  ctx: CoreContext,
  event: EventRow,
  sessionId: string,
): Promise<AccessDecision> {
  const state = computeSaleState(event);
  if (
    state === 'NOT_PUBLISHED' ||
    state === 'CANCELLED' ||
    state === 'ENDED' ||
    state === 'PAUSED'
  ) {
    return { status: 'CLOSED', reason: state };
  }
  const config = await effectiveQueueConfig(ctx, event.id);
  const opensAt = saleOpensAt(event);
  const code = await sessionCode(ctx, event.id, sessionId);
  const timing = { activeWindowMs: ACTIVE_WINDOW_MS, claimWindowMs: claimWindowMs(config) };
  const passTtlMs = config.passTokenTtlSeconds * 1000;

  if (state === 'NOT_STARTED') {
    const lobbyOpens =
      config.mode === 'SCHEDULED_PRE_REGISTRATION' && opensAt
        ? new Date(opensAt.getTime() - config.lobbyOpensMinutesBefore * 60_000)
        : null;
    if (lobbyOpens && Date.now() >= lobbyOpens.getTime()) {
      await ctx.queue.join(event.id, sessionId, true);
      return { status: 'LOBBY', saleOpensAt: opensAt!.toISOString() };
    }
    return {
      status: 'NOT_STARTED',
      saleOpensAt: opensAt?.toISOString() ?? null,
      lobbyOpensAt: lobbyOpens?.toISOString() ?? null,
    };
  }

  if (state === 'PRESALE' && !code.presale) return { status: 'CODE_REQUIRED', reason: 'PRESALE' };
  if (config.mode === 'VIP_CODE_ONLY' && !code.hasCode)
    return { status: 'CODE_REQUIRED', reason: 'VIP_ONLY' };

  const jti = randomUUID();
  const bypass =
    config.mode === 'OFF' ||
    config.mode === 'VIP_CODE_ONLY' ||
    (code.hasCode && code.bypass && (config.mode === 'HYBRID' || config.accessCodeBypassesQueue));

  if (bypass) {
    await ctx.queue.enterDirectly(event.id, sessionId, {
      ...timing,
      threshold: 0,
      jti,
      passTtlMs,
      bypassQueue: true,
    });
    return issuePass(ctx, event, sessionId, config, jti);
  }

  // Already admitted by the ticker → claim directly.
  const position = await ctx.queue.position(event.id, sessionId);
  if (position.admittedAt !== null) {
    return claimPass(ctx, event, sessionId);
  }

  const drawn = (await ctx.queue.snapshot(event.id)).drawnAt !== null;
  const directAllowed =
    !config.isPaused &&
    (config.mode === 'AUTO_THRESHOLD' || (config.mode === 'SCHEDULED_PRE_REGISTRATION' && drawn));
  if (directAllowed && position.number === null) {
    const entered = await ctx.queue.enterDirectly(event.id, sessionId, {
      ...timing,
      threshold: config.activeSessionThreshold,
      jti,
      passTtlMs,
      bypassQueue: false,
    });
    if (entered) return issuePass(ctx, event, sessionId, config, jti);
  }

  if (config.maxQueueSize !== null && position.number === null) {
    const snapshot = await ctx.queue.snapshot(event.id);
    if (snapshot.waiting >= config.maxQueueSize) {
      throw new DomainError('QUEUE_FULL', 'The waiting room is full. Please try again later.', 503);
    }
  }
  const preferLobby = config.mode === 'SCHEDULED_PRE_REGISTRATION' && !drawn;
  const joined = await ctx.queue.join(event.id, sessionId, preferLobby);
  if (joined.status === 'lobby')
    return { status: 'LOBBY', saleOpensAt: (opensAt ?? new Date()).toISOString() };
  if (joined.status === 'admitted') return claimPass(ctx, event, sessionId);
  return queuedDecision(ctx, event.id, joined.number, config);
}

async function queuedDecision(
  ctx: CoreContext,
  eventId: string,
  number: number,
  config: EffectiveQueueConfig,
): Promise<Extract<AccessDecision, { status: 'QUEUED' }>> {
  const snapshot = await ctx.queue.snapshot(eventId);
  const position = Math.max(1, number - snapshot.cursor);
  return {
    status: 'QUEUED',
    number,
    position,
    waiting: snapshot.waiting,
    estimatedWaitSeconds:
      Math.ceil(position / config.admissionBatchSize) * config.admissionIntervalSeconds,
    paused: config.isPaused,
  };
}

/** Status poll for the waiting room UI (fallback when WebSockets are unavailable). */
export async function queueStatus(
  ctx: CoreContext,
  event: EventRow,
  sessionId: string,
): Promise<AccessDecision> {
  const config = await effectiveQueueConfig(ctx, event.id);
  const position = await ctx.queue.position(event.id, sessionId);
  if (position.admittedAt !== null) {
    return { status: 'ADMITTED', claimBefore: position.admittedAt + claimWindowMs(config) };
  }
  if (position.inLobby)
    return { status: 'LOBBY', saleOpensAt: (saleOpensAt(event) ?? new Date()).toISOString() };
  if (position.number !== null) return queuedDecision(ctx, event.id, position.number, config);
  return enterShop(ctx, event, sessionId);
}

/** Converts an admission into a QueuePassToken. */
export async function claimPass(
  ctx: CoreContext,
  event: EventRow,
  sessionId: string,
): Promise<AccessDecision> {
  const config = await effectiveQueueConfig(ctx, event.id);
  const jti = randomUUID();
  const claimed = await ctx.queue.claim(event.id, sessionId, {
    claimWindowMs: claimWindowMs(config),
    jti,
    passTtlMs: config.passTokenTtlSeconds * 1000,
  });
  if (!claimed) {
    const position = await ctx.queue.position(event.id, sessionId);
    if (position.number !== null) return queuedDecision(ctx, event.id, position.number, config);
    throw new DomainError(
      'ADMISSION_EXPIRED',
      'Your admission expired. Please re-join the queue.',
      409,
    );
  }
  return issuePass(ctx, event, sessionId, config, jti);
}

/**
 * Redeems a VIP / presale code for this session. Single-use codes are bound to the first
 * session that redeems them (atomic conditional increment of `redemption_count`).
 */
export async function redeemAccessCode(
  ctx: CoreContext,
  event: EventRow,
  sessionId: string,
  rawCode: string,
): Promise<{ codeId: string; grantsPresaleAccess: boolean; bypassesQueue: boolean }> {
  const normalized = rawCode.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{4,64}$/.test(normalized))
    throw new DomainError('CODE_INVALID', 'Invalid code', 422);
  const now = new Date();
  const [code] = await ctx.db
    .select()
    .from(accessCodes)
    .where(
      and(
        eq(accessCodes.code, normalized),
        eq(accessCodes.isActive, true),
        or(eq(accessCodes.eventId, event.id), isNull(accessCodes.eventId)),
      ),
    )
    .orderBy(sql`${accessCodes.eventId} NULLS LAST`)
    .limit(1);
  if (
    !code ||
    (code.validFrom && code.validFrom > now) ||
    (code.validUntil && code.validUntil <= now)
  ) {
    throw new DomainError('CODE_INVALID', 'Invalid or expired code', 422);
  }

  const [existing] = await ctx.db
    .select({ id: accessCodeRedemptions.id })
    .from(accessCodeRedemptions)
    .where(
      and(
        eq(accessCodeRedemptions.accessCodeId, code.id),
        eq(accessCodeRedemptions.sessionId, sessionId),
      ),
    );
  if (!existing) {
    await ctx.db.transaction(async (tx) => {
      const updated = await tx
        .update(accessCodes)
        .set({ redemptionCount: sql`${accessCodes.redemptionCount} + 1` })
        .where(
          and(
            eq(accessCodes.id, code.id),
            or(
              isNull(accessCodes.maxRedemptions),
              sql`${accessCodes.redemptionCount} < ${accessCodes.maxRedemptions}`,
            ),
          ),
        )
        .returning({ id: accessCodes.id });
      if (updated.length === 0)
        throw new DomainError('CODE_EXHAUSTED', 'This code has already been used', 409);
      await tx.insert(accessCodeRedemptions).values({ accessCodeId: code.id, sessionId });
    });
  }
  await ctx.redis.set(ctx.keys.queueAccessCode(event.id, sessionId), code.id, 'EX', 24 * 3600);
  return {
    codeId: code.id,
    grantsPresaleAccess: code.grantsPresaleAccess,
    bypassesQueue: code.bypassesQueue,
  };
}

/** Requires a valid QueuePassToken (also issued instantly in mode OFF via `enterShop`). */
export async function requireShopAccess(
  ctx: CoreContext,
  event: EventRow,
  sessionId: string,
  passToken: string | undefined,
): Promise<void> {
  const state = computeSaleState(event);
  if (state !== 'ON_SALE' && state !== 'PRESALE') {
    throw new DomainError('SALE_CLOSED', 'Tickets for this event are not on sale', 403, { state });
  }
  if (await verifyPass(ctx, event.id, sessionId, passToken)) return;
  throw new DomainError('PASS_REQUIRED', 'Please enter the shop through the waiting room', 403);
}
