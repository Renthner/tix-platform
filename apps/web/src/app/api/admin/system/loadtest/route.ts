import {
  DomainError,
  LOAD_TEST_DEFAULT_MINUTES,
  LOAD_TEST_MAX_MINUTES,
  LOAD_TEST_MIN_MINUTES,
  beginPasskeyReauth,
  bindFromSecret,
  disableLoadTest,
  enableLoadTest,
  getLoadTestStatus,
} from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { reauthenticate, type ReauthError } from '@/server/admin/reauth';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, clientIp, enforceRateLimit, handle, parseBody } from '@/server/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('enable'),
    durationMinutes: z
      .number()
      .int()
      .min(LOAD_TEST_MIN_MINUTES)
      .max(LOAD_TEST_MAX_MINUTES)
      .default(LOAD_TEST_DEFAULT_MINUTES),
    password: z.string().min(1).max(1024),
    /** Authenticator or recovery code (or a passkey assertion below). */
    code: z.string().max(64).optional(),
    passkeyChallengeId: z.string().max(200).optional(),
    passkeyResponse: z.string().max(20_000).optional(),
  }),
  z.object({ action: z.literal('passkeyOptions') }),
  z.object({ action: z.literal('disable') }),
]);

/** Challenge of the passkey confirmation is bound to this action (not usable for a restore). */
const enableBind = () => bindFromSecret('loadtest-enable');

const REAUTH_ERRORS: Record<ReauthError, [code: string, message: string]> = {
  password: ['WRONG_PASSWORD', 'The password is not correct'],
  twoFactorSetupRequired: [
    'TWO_FACTOR_REQUIRED',
    'Set up an authenticator app or a passkey before enabling the load test mode',
  ],
  twoFactorRequired: ['TWO_FACTOR_CODE_REQUIRED', 'Enter your authenticator code or use a passkey'],
  twoFactorInvalid: ['TWO_FACTOR_INVALID', 'The code is not correct'],
  passkeyInvalid: ['PASSKEY_INVALID', 'The passkey could not be verified'],
  locked: ['ACCOUNT_LOCKED', 'The account is temporarily locked'],
};

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** GET – status of the load test mode (never returns the token). */
export async function GET() {
  return handle(async () => {
    const session = await adminForApi(['SUPER_ADMIN']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    return json(await getLoadTestStatus(getCore()));
  });
}

/**
 * POST – enable (SUPER_ADMIN whose account has a second factor or passkey; password AND a fresh
 * authenticator code / recovery code / passkey assertion are required) or disable. The token is returned once, by `enable` only.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['SUPER_ADMIN']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const input = await parseBody(request, bodySchema);
    const core = getCore();
    const ip = await clientIp();
    if (input.action === 'disable') {
      const changed = await disableLoadTest(core, { userId: session.userId, ipAddress: ip });
      return json({ ...(await getLoadTestStatus(core)), changed });
    }
    if (input.action === 'passkeyOptions') {
      await enforceRateLimit('loadtest-options', session.userId, 20, 15 * 60_000);
      try {
        return json({
          ok: true,
          ...(await beginPasskeyReauth(core, session.userId, enableBind(), 'loadtest')),
        });
      } catch (err) {
        if (err instanceof DomainError)
          return apiError('PASSKEY_INVALID', 'No passkey available', 400);
        throw err;
      }
    }
    await enforceRateLimit('loadtest-enable', session.userId, 5, 15 * 60_000);
    const fd = new FormData();
    fd.set('password', input.password);
    if (input.code) fd.set('code', input.code);
    if (input.passkeyChallengeId) fd.set('passkeyChallengeId', input.passkeyChallengeId);
    if (input.passkeyResponse) fd.set('passkeyResponse', input.passkeyResponse);
    // Fresh password + second factor (a passkey challenge only for THIS action); accounts without
    // any second factor are refused.
    const denied = await reauthenticate(core, session, fd, {
      purpose: 'loadtest',
      bind: enableBind(),
      requireTwoFactor: true,
    });
    if (denied) {
      const [code, message] = REAUTH_ERRORS[denied];
      return apiError(code, message, 403);
    }
    const run = await enableLoadTest(core, {
      userId: session.userId,
      durationMinutes: input.durationMinutes,
      ipAddress: ip,
    });
    return json({
      active: true,
      runId: run.runId,
      expiresAt: run.expiresAt.toISOString(),
      token: run.token,
    });
  });
}
