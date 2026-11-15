/**
 * Admin passkeys against real PostgreSQL + Redis (throwaway database). A software authenticator
 * drives the real @simplewebauthn/server verification: registration, single-use challenges,
 * usernameless / second-factor sign-in, counter (clone) detection, mandatory-2FA enforcement for
 * super admins and the last-factor removal guard.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminPasskeys,
  adminSessions,
  adminUsers,
  auditLogs,
  createDb,
  emailMessages,
  loadRootEnv,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, hashPassword, parseKeyRing } from '@tix/shared/server';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  adminNeedsTwoFactorSetup,
  beginPasskeyLogin,
  beginPasskeyReauth,
  beginPasskeyRegistration,
  regenerateRecoveryCodesWithProof,
  beginPasskeySecondFactor,
  bindFromSecret,
  checkAdminPassword,
  createCoreContext,
  finishPasskeyRegistration,
  listOwnPasskeys,
  getOwnAccount,
  removePasskey,
  renamePasskey,
  resetAdminTwoFactor,
  saveSetting,
  verifyAdminSecondFactor,
  verifyPasskeyAuthentication,
  type CoreContext,
  type JobQueues,
} from '../src';
import { SoftwareAuthenticator } from './helpers/software-authenticator';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const PASSWORD = 'correct horse battery';
const APP_URL = 'https://shop.example.org';
const RP = { rpID: 'shop.example.org', origin: APP_URL };

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

describe.skipIf(!adminUrl || !redisUrl)('admin passkeys (integration)', () => {
  const dbName = `tix_passkeys_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  const secretBox = createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`));

  async function makeUser(
    email: string,
    roles: ('SUPER_ADMIN' | 'EVENT_MANAGER' | 'FINANCE' | 'DOOR_STAFF')[] = ['EVENT_MANAGER'],
  ): Promise<string> {
    const [row] = await handle.db
      .insert(adminUsers)
      .values({
        email,
        displayName: email.split('@')[0]!,
        roles,
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning({ id: adminUsers.id });
    return row!.id;
  }

  /** First passkey of each test user: proves the second factor when a further one is added. */
  const firstAuthenticator = new Map<string, SoftwareAuthenticator>();

  /** Registers `authenticator` for the user through the real begin/finish flow. */
  async function addPasskey(userId: string, authenticator: SoftwareAuthenticator, name = 'Laptop') {
    const bind = `session-${userId}`;
    const existing = firstAuthenticator.get(userId);
    let proof: { passkey: { challengeId: string; response: unknown } } | undefined;
    if (existing) {
      const reauth = await beginPasskeyReauth(ctx, userId, bind, 'add-passkey');
      proof = {
        passkey: {
          challengeId: reauth.challengeId,
          response: existing.assert(reauth.options.challenge),
        },
      };
    } else {
      firstAuthenticator.set(userId, authenticator);
    }
    const { options, challengeId } = await beginPasskeyRegistration(
      ctx,
      { userId },
      PASSWORD,
      bind,
      proof,
    );
    return finishPasskeyRegistration(
      ctx,
      { userId },
      { challengeId, response: authenticator.register(options.challenge), name, bind },
    );
  }

  async function loginWith(
    authenticator: SoftwareAuthenticator,
    opts: { userHandle?: string } = {},
  ) {
    const bind = bindFromSecret(randomUUID());
    const { options, challengeId } = await beginPasskeyLogin(ctx, bind);
    const response = authenticator.assert(options.challenge, opts);
    return { bind, challengeId, response };
  }

  const auditActions = async (userId: string) =>
    (
      await handle.db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.actorUserId, userId))
    ).map((r) => r.action);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 5 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: APP_URL,
      secrets: secretBox,
      jobs: { add: async () => 'job' } as unknown as JobQueues,
    });
  });

  afterAll(async () => {
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('registers a passkey after password re-confirmation; recovery codes only come with the first', async () => {
    const userId = await makeUser('reg@example.org');
    await expectCode(
      beginPasskeyRegistration(ctx, { userId }, 'wrong password', 'b'),
      'WRONG_PASSWORD',
    );
    const first = await addPasskey(userId, new SoftwareAuthenticator(RP), 'Laptop');
    expect(first.recoveryCodes).toHaveLength(10);
    expect(first.passkey.name).toBe('Laptop');
    const second = await addPasskey(userId, new SoftwareAuthenticator(RP), 'Phone');
    expect(second.recoveryCodes).toBeNull();
    expect(await listOwnPasskeys(ctx, userId)).toHaveLength(2);
    expect(await auditActions(userId)).toContain('admin_user.passkey_registered');
    expect((await getOwnAccount(ctx, userId)).passkeyCount).toBe(2);
  });

  it('adding a further passkey needs proof of the existing second factor and notifies the owner', async () => {
    const userId = await makeUser('proof@example.org');
    const first = await addPasskey(userId, new SoftwareAuthenticator(RP), 'First');
    const bind = `session-${userId}`;
    // password alone is not enough
    await expectCode(beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind), 'INVALID_CODE');
    await expectCode(
      beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind, { code: '123456' }),
      'INVALID_CODE',
    );
    // a recovery code works
    const ok = await beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind, {
      code: first.recoveryCodes![0]!,
    });
    expect(ok.challengeId).toBeTruthy();
    // a passkey assertion for another purpose / binding does not
    const wrong = await beginPasskeyReauth(ctx, userId, bind, 'recovery-codes');
    await expectCode(
      beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind, {
        passkey: {
          challengeId: wrong.challengeId,
          response: firstAuthenticator.get(userId)!.assert(wrong.options.challenge),
        },
      }),
      'PASSKEY_INVALID',
    );
    // the notification mail exists (first passkey and added one)
    const mails = await handle.db
      .select({ key: emailMessages.templateKey, to: emailMessages.toEmail })
      .from(emailMessages)
      .where(eq(emailMessages.toEmail, 'proof@example.org'));
    expect(mails.filter((m) => m.key === 'ADMIN_PASSKEY_ADDED')).toHaveLength(1);
  });

  it('passkey-only users regenerate recovery codes with password + passkey assertion', async () => {
    const userId = await makeUser('regen@example.org');
    const authenticator = new SoftwareAuthenticator(RP);
    const first = await addPasskey(userId, authenticator);
    const bind = `session-${userId}`;
    const reauth = await beginPasskeyReauth(ctx, userId, bind, 'recovery-codes');
    const { recoveryCodes } = await regenerateRecoveryCodesWithProof(
      ctx,
      { userId },
      PASSWORD,
      bind,
      {
        passkey: {
          challengeId: reauth.challengeId,
          response: authenticator.assert(reauth.options.challenge),
        },
      },
    );
    expect(recoveryCodes).toHaveLength(10);
    // the old codes are gone
    await expectCode(
      verifyAdminSecondFactor(ctx, userId, first.recoveryCodes![0]!),
      'INVALID_CODE',
    );
    await expect(verifyAdminSecondFactor(ctx, userId, recoveryCodes[0]!)).resolves.toBe(
      'recovery_code',
    );
  });

  it('the first second factor ends other sessions and marks the current one verified', async () => {
    const userId = await makeUser('sessions@example.org');
    const expiresAt = new Date(Date.now() + 3_600_000);
    await handle.db.insert(adminSessions).values([
      { tokenHash: `keep-${userId}`, userId, expiresAt },
      { tokenHash: `other-${userId}`, userId, expiresAt },
    ]);
    const bind = `keep-${userId}`;
    const begin = await beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind);
    await finishPasskeyRegistration(
      ctx,
      { userId },
      {
        challengeId: begin.challengeId,
        response: new SoftwareAuthenticator(RP).register(begin.options.challenge),
        name: 'First',
        bind,
        keepSessionTokenHash: bind,
      },
    );
    const sessions = await handle.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.userId, userId));
    expect(sessions.map((s) => s.tokenHash)).toEqual([bind]);
    expect(sessions[0]!.mfaVerifiedAt).not.toBeNull();
  });

  it('challenges are single use, bound and origin/UV checked', async () => {
    const userId = await makeUser('chal@example.org');
    const authenticator = new SoftwareAuthenticator(RP);
    const bind = 'session-a';
    const begin = await beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind);
    const response = authenticator.register(begin.options.challenge);
    // wrong binding burns the challenge
    await expectCode(
      finishPasskeyRegistration(
        ctx,
        { userId },
        { challengeId: begin.challengeId, response, name: 'x', bind: 'other' },
      ),
      'PASSKEY_INVALID',
    );
    await expectCode(
      finishPasskeyRegistration(
        ctx,
        { userId },
        { challengeId: begin.challengeId, response, name: 'x', bind },
      ),
      'PASSKEY_INVALID',
    );
    // wrong origin
    const b2 = await beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind);
    await expectCode(
      finishPasskeyRegistration(
        ctx,
        { userId },
        {
          challengeId: b2.challengeId,
          response: authenticator.register(b2.options.challenge, {
            origin: 'https://evil.example.com',
          }),
          name: 'x',
          bind,
        },
      ),
      'PASSKEY_INVALID',
    );
    // no user verification
    const b3 = await beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind);
    const noUv = new SoftwareAuthenticator(RP);
    noUv.userVerified = false;
    await expectCode(
      finishPasskeyRegistration(
        ctx,
        { userId },
        {
          challengeId: b3.challengeId,
          response: noUv.register(b3.options.challenge),
          name: 'x',
          bind,
        },
      ),
      'PASSKEY_INVALID',
    );
    // another user cannot complete somebody else's challenge
    const other = await makeUser('chal-other@example.org');
    const b4 = await beginPasskeyRegistration(ctx, { userId }, PASSWORD, bind);
    await expectCode(
      finishPasskeyRegistration(
        ctx,
        { userId: other },
        {
          challengeId: b4.challengeId,
          response: authenticator.register(b4.options.challenge),
          name: 'x',
          bind,
        },
      ),
      'PASSKEY_INVALID',
    );
    expect(await listOwnPasskeys(ctx, userId)).toHaveLength(0);
  });

  it('signs in usernameless, updates the counter and rejects replays', async () => {
    const userId = await makeUser('login@example.org');
    const authenticator = new SoftwareAuthenticator(RP);
    await addPasskey(userId, authenticator);
    const attempt = await loginWith(authenticator, { userHandle: userId });
    await expect(
      verifyPasskeyAuthentication(ctx, { purpose: 'login', ...attempt }),
    ).resolves.toEqual({ userId });
    const [row] = await handle.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.adminUserId, userId));
    expect(row!.counter).toBe(1);
    expect(row!.lastUsedAt).not.toBeNull();
    // the same challenge cannot be used twice
    await expectCode(
      verifyPasskeyAuthentication(ctx, { purpose: 'login', ...attempt }),
      'PASSKEY_INVALID',
    );
    // challenge bound to another browser
    const stolen = await loginWith(authenticator);
    await expectCode(
      verifyPasskeyAuthentication(ctx, { purpose: 'login', ...stolen, bind: 'someone-else' }),
      'PASSKEY_INVALID',
    );
    // wrong origin / unknown credential / wrong user handle
    const bind = bindFromSecret('x');
    const begin = await beginPasskeyLogin(ctx, bind);
    await expectCode(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'login',
        challengeId: begin.challengeId,
        bind,
        response: authenticator.assert(begin.options.challenge, {
          origin: 'https://evil.example.com',
        }),
      }),
      'PASSKEY_INVALID',
    );
    const unknown = new SoftwareAuthenticator(RP);
    await expectCode(
      verifyPasskeyAuthentication(ctx, { purpose: 'login', ...(await loginWith(unknown)) }),
      'PASSKEY_INVALID',
    );
    await expectCode(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'login',
        ...(await loginWith(authenticator, { userHandle: randomUUID() })),
      }),
      'PASSKEY_INVALID',
    );
  });

  it('a forged signature with a low counter is a plain login failure, not a clone alarm', async () => {
    const userId = await makeUser('forged@example.org');
    const authenticator = new SoftwareAuthenticator(RP);
    await addPasskey(userId, authenticator);
    await verifyPasskeyAuthentication(ctx, {
      purpose: 'login',
      ...(await loginWith(authenticator)),
    });
    const bind = bindFromSecret('forged');
    const begin = await beginPasskeyLogin(ctx, bind);
    const forged = authenticator.assert(begin.options.challenge, { counter: 1 });
    const sig = Buffer.from(forged.response.signature, 'base64url');
    sig[sig.length - 1] = sig[sig.length - 1]! ^ 0xff;
    sig[10] = sig[10]! ^ 0xff;
    forged.response.signature = sig.toString('base64url');
    await expectCode(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'login',
        challengeId: begin.challengeId,
        bind,
        response: forged,
      }),
      'PASSKEY_INVALID',
    );
    expect(await auditActions(userId)).not.toContain('admin_user.passkey_clone_suspected');
    // the stored counter did not move
    const [row] = await handle.db
      .select()
      .from(adminPasskeys)
      .where(eq(adminPasskeys.adminUserId, userId));
    expect(row!.counter).toBe(1);
  });

  it('detects counter regressions as clone suspicion; synced passkeys (counter 0) are fine', async () => {
    const userId = await makeUser('clone@example.org');
    const authenticator = new SoftwareAuthenticator(RP);
    await addPasskey(userId, authenticator);
    const ok = await loginWith(authenticator);
    await verifyPasskeyAuthentication(ctx, { purpose: 'login', ...ok });
    // a clone replays a signature with a counter that did not advance
    const bind = bindFromSecret('clone');
    const begin = await beginPasskeyLogin(ctx, bind);
    await expectCode(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'login',
        challengeId: begin.challengeId,
        bind,
        response: authenticator.assert(begin.options.challenge, { counter: 1 }),
      }),
      'PASSKEY_INVALID',
    );
    expect(await auditActions(userId)).toContain('admin_user.passkey_clone_suspected');

    const syncedUser = await makeUser('synced@example.org');
    const synced = new SoftwareAuthenticator(RP);
    synced.synced = true;
    await addPasskey(syncedUser, synced);
    await verifyPasskeyAuthentication(ctx, { purpose: 'login', ...(await loginWith(synced)) });
    await verifyPasskeyAuthentication(ctx, { purpose: 'login', ...(await loginWith(synced)) });
  });

  it('rejects inactive, locked and invitation-only accounts', async () => {
    const inactive = await makeUser('inactive@example.org');
    const a1 = new SoftwareAuthenticator(RP);
    await addPasskey(inactive, a1);
    await handle.db.update(adminUsers).set({ isActive: false }).where(eq(adminUsers.id, inactive));
    await expectCode(
      verifyPasskeyAuthentication(ctx, { purpose: 'login', ...(await loginWith(a1)) }),
      'PASSKEY_INVALID',
    );

    const locked = await makeUser('locked@example.org');
    const a2 = new SoftwareAuthenticator(RP);
    await addPasskey(locked, a2);
    await handle.db
      .update(adminUsers)
      .set({ lockedUntil: new Date(Date.now() + 600_000) })
      .where(eq(adminUsers.id, locked));
    await expectCode(
      verifyPasskeyAuthentication(ctx, { purpose: 'login', ...(await loginWith(a2)) }),
      'ACCOUNT_LOCKED',
    );
  });

  it('second factor: bound to the pending login and user; counts as 2FA at the password step', async () => {
    const userId = await makeUser('second@example.org');
    const authenticator = new SoftwareAuthenticator(RP);
    expect(await checkAdminPassword(ctx, 'second@example.org', PASSWORD)).toMatchObject({
      status: 'ok',
      twoFactor: false,
    });
    await addPasskey(userId, authenticator);
    expect(await checkAdminPassword(ctx, 'second@example.org', PASSWORD)).toMatchObject({
      status: 'ok',
      twoFactor: true,
    });
    const nonce = 'pending-nonce-1';
    const begin = await beginPasskeySecondFactor(ctx, userId, nonce);
    expect(begin.options.allowCredentials).toHaveLength(1);
    const response = authenticator.assert(begin.options.challenge);
    // another user's pending login cannot use it
    const other = await makeUser('second-other@example.org');
    await expectCode(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'second-factor',
        challengeId: begin.challengeId,
        response,
        bind: nonce,
        expectedUserId: other,
      }),
      'PASSKEY_INVALID',
    );
    // ... and the challenge is burnt by that attempt
    await expectCode(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'second-factor',
        challengeId: begin.challengeId,
        response,
        bind: nonce,
        expectedUserId: userId,
      }),
      'PASSKEY_INVALID',
    );
    const fresh = await beginPasskeySecondFactor(ctx, userId, nonce);
    await expect(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'second-factor',
        challengeId: fresh.challengeId,
        response: authenticator.assert(fresh.options.challenge),
        bind: nonce,
        expectedUserId: userId,
      }),
    ).resolves.toEqual({ userId });
    // users without passkeys cannot start a passkey second factor
    await expectCode(beginPasskeySecondFactor(ctx, other, 'n2'), 'PASSKEY_INVALID');
  });

  it('restore confirmation: bound to user + backup, single use, purpose-separated, UV required', async () => {
    const userId = await makeUser('restore@example.org', ['SUPER_ADMIN']);
    const other = await makeUser('restore-other@example.org', ['SUPER_ADMIN']);
    const authenticator = new SoftwareAuthenticator(RP);
    await addPasskey(userId, authenticator);
    await addPasskey(other, new SoftwareAuthenticator(RP), 'Other');
    const bindA = bindFromSecret('restore:backup-a');
    const bindB = bindFromSecret('restore:backup-b');
    const verify = (
      challengeId: string,
      response: unknown,
      bind: string,
      expectedUserId: string,
      purpose: 'restore' | 'second-factor' = 'restore',
    ) => verifyPasskeyAuthentication(ctx, { purpose, challengeId, response, bind, expectedUserId });

    // users without a passkey cannot start one
    const none = await makeUser('restore-none@example.org', ['SUPER_ADMIN']);
    await expectCode(beginPasskeyReauth(ctx, none, bindA), 'PASSKEY_INVALID');

    // happy path, then replay of the same challenge fails
    const ok = await beginPasskeyReauth(ctx, userId, bindA);
    expect(ok.options.userVerification).toBe('required');
    expect(ok.options.allowCredentials).toHaveLength(1);
    const assertion = authenticator.assert(ok.options.challenge);
    await expect(verify(ok.challengeId, assertion, bindA, userId)).resolves.toEqual({ userId });
    await expectCode(verify(ok.challengeId, assertion, bindA, userId), 'PASSKEY_INVALID');

    // bound to the backup: a challenge for backup A does not confirm backup B (and is burnt)
    const forA = await beginPasskeyReauth(ctx, userId, bindA);
    await expectCode(
      verify(forA.challengeId, authenticator.assert(forA.options.challenge), bindB, userId),
      'PASSKEY_INVALID',
    );
    await expectCode(
      verify(forA.challengeId, authenticator.assert(forA.options.challenge), bindA, userId),
      'PASSKEY_INVALID',
    );

    // bound to the user: another admin cannot consume it
    const forUser = await beginPasskeyReauth(ctx, userId, bindA);
    await expectCode(
      verify(forUser.challengeId, authenticator.assert(forUser.options.challenge), bindA, other),
      'PASSKEY_INVALID',
    );

    // purpose separation: a restore challenge is not a second-factor / login challenge
    const sep = await beginPasskeyReauth(ctx, userId, 'nonce');
    await expectCode(
      verify(
        sep.challengeId,
        authenticator.assert(sep.options.challenge),
        'nonce',
        userId,
        'second-factor',
      ),
      'PASSKEY_INVALID',
    );
    // ... and a second-factor challenge cannot confirm a restore
    const sf = await beginPasskeySecondFactor(ctx, userId, bindA);
    await expectCode(
      verify(sf.challengeId, authenticator.assert(sf.options.challenge), bindA, userId),
      'PASSKEY_INVALID',
    );

    // user verification is required
    const uv = await beginPasskeyReauth(ctx, userId, bindA);
    authenticator.userVerified = false;
    await expectCode(
      verify(uv.challengeId, authenticator.assert(uv.options.challenge), bindA, userId),
      'PASSKEY_INVALID',
    );
    authenticator.userVerified = true;

    // a missing expected user never matches
    const noUser = await beginPasskeyReauth(ctx, userId, bindA);
    await expectCode(
      verifyPasskeyAuthentication(ctx, {
        purpose: 'restore',
        challengeId: noUser.challengeId,
        response: authenticator.assert(noUser.options.challenge),
        bind: bindA,
      }),
      'PASSKEY_INVALID',
    );
  });

  it('recovery codes work for passkey-only users; reset clears passkeys and codes', async () => {
    const userId = await makeUser('recovery@example.org');
    const { recoveryCodes } = await addPasskey(userId, new SoftwareAuthenticator(RP));
    await expect(verifyAdminSecondFactor(ctx, userId, recoveryCodes![0]!)).resolves.toBe(
      'recovery_code',
    );
    // digits are not a recovery code and there is no authenticator app
    await expectCode(verifyAdminSecondFactor(ctx, userId, '123456'), 'INVALID_CODE');

    await resetAdminTwoFactor(ctx, { userId: null }, userId);
    expect(await listOwnPasskeys(ctx, userId)).toHaveLength(0);
    expect(await checkAdminPassword(ctx, 'recovery@example.org', PASSWORD)).toMatchObject({
      twoFactor: false,
    });
    const [audit] = await handle.db
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityId, userId), eq(auditLogs.action, 'admin_user.two_factor_reset')),
      );
    expect(audit!.changes).toMatchObject({ removedPasskeys: 1 });
  });

  it('mandatory 2FA for super admins: passkey satisfies it, last factor cannot be removed', async () => {
    const superUser = await makeUser('super@example.org', ['SUPER_ADMIN']);
    const manager = await makeUser('manager@example.org', ['EVENT_MANAGER']);
    // default: off
    expect(await adminNeedsTwoFactorSetup(ctx, superUser)).toBe(false);
    await saveSetting(ctx, 'security', { requireTwoFactorForSuperAdmins: true }, null);
    try {
      expect(await adminNeedsTwoFactorSetup(ctx, superUser)).toBe(true);
      expect(await adminNeedsTwoFactorSetup(ctx, manager)).toBe(false);
      expect((await getOwnAccount(ctx, superUser)).twoFactorRequired).toBe(true);
      expect((await getOwnAccount(ctx, manager)).twoFactorRequired).toBe(false);

      const first = await addPasskey(superUser, new SoftwareAuthenticator(RP), 'A');
      expect(await adminNeedsTwoFactorSetup(ctx, superUser)).toBe(false);
      // the only factor cannot go
      await expectCode(
        removePasskey(ctx, { userId: superUser }, first.passkey.id, PASSWORD),
        'TWO_FACTOR_REQUIRED',
      );
      // with a second passkey the first can be removed; password is re-checked
      const second = await addPasskey(superUser, new SoftwareAuthenticator(RP), 'B');
      await expectCode(
        removePasskey(ctx, { userId: superUser }, first.passkey.id, 'wrong'),
        'WRONG_PASSWORD',
      );
      await removePasskey(ctx, { userId: superUser }, first.passkey.id, PASSWORD);
      await expectCode(
        removePasskey(ctx, { userId: superUser }, second.passkey.id, PASSWORD),
        'TWO_FACTOR_REQUIRED',
      );
      expect(await auditActions(superUser)).toContain('admin_user.passkey_removed');
      // other users' passkeys are not reachable
      const foreign = await addPasskey(manager, new SoftwareAuthenticator(RP), 'M');
      await expectCode(
        removePasskey(ctx, { userId: superUser }, foreign.passkey.id, PASSWORD),
        'PASSKEY_NOT_FOUND',
      );
    } finally {
      await saveSetting(ctx, 'security', { requireTwoFactorForSuperAdmins: false }, null);
    }
    // not mandatory any more: the last passkey may go, recovery codes go with it
    await removePasskey(
      ctx,
      { userId: superUser },
      (await listOwnPasskeys(ctx, superUser))[0]!.id,
      PASSWORD,
    );
    expect((await getOwnAccount(ctx, superUser)).recoveryCodesLeft).toBe(0);
  });

  it('renames only own passkeys and enforces the limit', async () => {
    const userId = await makeUser('rename@example.org');
    const { passkey } = await addPasskey(userId, new SoftwareAuthenticator(RP), 'Old');
    await renamePasskey(ctx, { userId }, passkey.id, '  New name  ');
    expect((await listOwnPasskeys(ctx, userId))[0]!.name).toBe('New name');
    const other = await makeUser('rename-other@example.org');
    await expectCode(renamePasskey(ctx, { userId: other }, passkey.id, 'x'), 'PASSKEY_NOT_FOUND');
    await expectCode(renamePasskey(ctx, { userId }, passkey.id, '   '), 'VALIDATION');
    for (let i = 0; i < 9; i += 1) await addPasskey(userId, new SoftwareAuthenticator(RP), `K${i}`);
    // password re-confirmations are rate limited per admin: start a fresh window
    const limits = await redis.keys(`${ctx.keys.prefix}:*admin-reconfirm*`);
    if (limits.length) await redis.del(...limits);
    const reauth = await beginPasskeyReauth(ctx, userId, 'b', 'add-passkey');
    await expectCode(
      beginPasskeyRegistration(ctx, { userId }, PASSWORD, 'b', {
        passkey: {
          challengeId: reauth.challengeId,
          response: firstAuthenticator.get(userId)!.assert(reauth.options.challenge),
        },
      }),
      'PASSKEY_LIMIT',
    );
  });

  it('is unavailable without a usable public URL', async () => {
    const insecure = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: ctx.keys.prefix,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'http://192.168.1.5:8080',
      secrets: secretBox,
    });
    await expectCode(beginPasskeyLogin(insecure, 'b'), 'PASSKEYS_UNAVAILABLE');
  });
});
