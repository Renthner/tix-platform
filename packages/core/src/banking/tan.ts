import { bankTanChallenges } from '@tix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { setRunStatus } from './runs';

/**
 * PSD2 strong customer authentication for FinTS. A FinTS dialog can only be continued by the
 * client instance that started it, so the worker keeps the dialog open and waits:
 *  1. worker: `openTanChallenge` → row in bank_tan_challenges (text / photoTAN / decoupled),
 *     run status TAN_REQUIRED (shown in the Admin Portal),
 *  2. admin: `respondToTanChallenge` → TAN encrypted into a short-lived Redis key (never in
 *     PostgreSQL), or "approved in the app" for decoupled procedures, or cancel,
 *  3. worker: `takeTanResponse` (GETDEL) → continues the dialog → `closeTanChallenge`.
 */

export type TanResponse =
  { kind: 'TAN'; tan: string } | { kind: 'DECOUPLED_CONFIRMED' } | { kind: 'CANCELLED' };

const storedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TAN'), tan: z.string() }),
  z.object({ kind: z.literal('DECOUPLED_CONFIRMED') }),
  z.object({ kind: z.literal('CANCELLED') }),
]);

const tanContext = (challengeId: string) => `bank_tan_challenges.response:${challengeId}`;

/** TANs are short alphanumeric codes; anything else is rejected before reaching the bank. */
export const TAN_PATTERN = /^[A-Za-z0-9]{1,32}$/;

export interface OpenTanChallengeInput {
  connectionId: string;
  syncRunId: string;
  tanMethod?: string | null;
  challengeText?: string | null;
  media?: { mimeType: string; data: Uint8Array } | null;
  isDecoupled: boolean;
  timeoutMs: number;
}

export async function openTanChallenge(
  ctx: CoreContext,
  input: OpenTanChallengeInput,
): Promise<{ id: string; expiresAt: Date }> {
  // Only one open challenge per connection.
  await ctx.db
    .update(bankTanChallenges)
    .set({ status: 'EXPIRED' })
    .where(
      and(
        eq(bankTanChallenges.connectionId, input.connectionId),
        inArray(bankTanChallenges.status, ['PENDING', 'SUBMITTED']),
      ),
    );
  const expiresAt = new Date(Date.now() + input.timeoutMs);
  const [row] = await ctx.db
    .insert(bankTanChallenges)
    .values({
      connectionId: input.connectionId,
      syncRunId: input.syncRunId,
      status: 'PENDING',
      tanMethod: input.tanMethod?.slice(0, 200) ?? null,
      challengeText: input.challengeText?.slice(0, 4000) ?? null,
      challengeMediaMimeType: input.media?.mimeType ?? null,
      challengeMediaBase64: input.media ? Buffer.from(input.media.data).toString('base64') : null,
      isDecoupled: input.isDecoupled,
      expiresAt,
    })
    .returning({ id: bankTanChallenges.id });
  await setRunStatus(ctx, input.syncRunId, input.connectionId, 'TAN_REQUIRED');
  return { id: row!.id, expiresAt };
}

/** Non-blocking: returns (and removes) the admin's response if there is one. */
export async function takeTanResponse(
  ctx: CoreContext,
  challengeId: string,
): Promise<TanResponse | null> {
  const raw = await ctx.redis.getdel(ctx.keys.bankTanResponse(challengeId));
  if (!raw) return null;
  const stored = storedSchema.parse(JSON.parse(raw));
  if (stored.kind !== 'TAN') return stored;
  const secrets = requireCapability(ctx, 'secrets');
  return { kind: 'TAN', tan: secrets.decrypt(stored.tan, tanContext(challengeId)) };
}

export async function closeTanChallenge(
  ctx: CoreContext,
  params: {
    challengeId: string;
    syncRunId: string;
    connectionId: string;
    status: 'COMPLETED' | 'EXPIRED' | 'FAILED';
  },
): Promise<void> {
  await ctx.db
    .update(bankTanChallenges)
    .set({ status: params.status })
    .where(
      and(
        eq(bankTanChallenges.id, params.challengeId),
        inArray(bankTanChallenges.status, ['PENDING', 'SUBMITTED']),
      ),
    );
  await ctx.redis.del(ctx.keys.bankTanResponse(params.challengeId));
  await setRunStatus(ctx, params.syncRunId, params.connectionId, 'RUNNING');
}

/** Admin side: forwards a TAN / decoupled approval / cancellation to the waiting worker. */
export async function respondToTanChallenge(
  ctx: CoreContext,
  params: { challengeId: string; userId: string; response: TanResponse },
): Promise<void> {
  const [challenge] = await ctx.db
    .select({
      id: bankTanChallenges.id,
      status: bankTanChallenges.status,
      expiresAt: bankTanChallenges.expiresAt,
      isDecoupled: bankTanChallenges.isDecoupled,
    })
    .from(bankTanChallenges)
    .where(eq(bankTanChallenges.id, params.challengeId));
  if (!challenge) throw new DomainError('TAN_NOT_FOUND', 'TAN challenge not found', 404);
  const ttlMs = challenge.expiresAt.getTime() - Date.now();
  if (challenge.status !== 'PENDING' || ttlMs <= 1000) {
    throw new DomainError('TAN_NOT_PENDING', 'The TAN challenge is no longer open', 409);
  }
  let stored: z.infer<typeof storedSchema>;
  if (params.response.kind === 'TAN') {
    const tan = params.response.tan.replace(/\s/g, '');
    if (!TAN_PATTERN.test(tan)) throw new DomainError('TAN_INVALID', 'Invalid TAN format', 422);
    const secrets = requireCapability(ctx, 'secrets');
    stored = { kind: 'TAN', tan: secrets.encrypt(tan, tanContext(challenge.id)) };
  } else {
    stored = params.response;
  }
  await ctx.redis.set(
    ctx.keys.bankTanResponse(challenge.id),
    JSON.stringify(stored),
    'PX',
    Math.max(1000, ttlMs),
  );
  await ctx.db
    .update(bankTanChallenges)
    .set({
      status: params.response.kind === 'CANCELLED' ? 'FAILED' : 'SUBMITTED',
      respondedByUserId: params.userId,
      respondedAt: new Date(),
    })
    .where(and(eq(bankTanChallenges.id, challenge.id), eq(bankTanChallenges.status, 'PENDING')));
}
