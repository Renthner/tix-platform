/**
 * Admin users against real PostgreSQL + Redis (throwaway database): invitations, password reset,
 * lockout, TOTP two-factor with replay protection, recovery codes and the last-super-admin
 * guard. E-mails go through the real outbox; links are read from the encrypted variables.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminSessions,
  adminTokens,
  adminUsers,
  auditLogs,
  createDb,
  emailMessages,
  loadRootEnv,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, hashPassword, parseKeyRing, totpAt } from '@tix/shared/server';
import { asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  EMAIL_VARIABLES_CONTEXT,
  acceptAdminInvite,
  beginTotpSetup,
  changeOwnPassword,
  checkAdminPassword,
  completeAdminLogin,
  confirmTotpSetup,
  createCoreContext,
  deleteAdminInvite,
  disableTotp,
  inviteAdminUser,
  isAdminTokenValid,
  listAdminUsers,
  normalizeRecoveryCode,
  parseStoredEmailRequest,
  requestAdminPasswordReset,
  resendAdminInvite,
  resetAdminPassword,
  resetAdminTwoFactor,
  saveSetting,
  setAdminUserActive,
  unlockAdminUser,
  updateAdminUser,
  verifyAdminSecondFactor,
  type CoreContext,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const PASSWORD = 'correct horse battery';

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

describe.skipIf(!adminUrl || !redisUrl)('admin users (integration)', () => {
  const dbName = `tix_adminusers_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  const queued: string[] = [];
  const secretBox = createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`));

  async function mailsTo(email: string) {
    const rows = await handle.db
      .select({ key: emailMessages.templateKey, payload: emailMessages.attachments })
      .from(emailMessages)
      .where(sql`lower(${emailMessages.toEmail}) = ${email.toLowerCase()}`)
      .orderBy(asc(emailMessages.createdAt), asc(emailMessages.id));
    return rows.map((row) => {
      const stored = parseStoredEmailRequest(row.payload);
      const variables = stored.variables
        ? secretBox.decryptJson<Record<string, string>>(stored.variables, EMAIL_VARIABLES_CONTEXT)
        : {};
      return { key: row.key, locale: stored.locale, variables };
    });
  }
  const tokenOf = (url: string | undefined) => new URL(url!).searchParams.get('token')!;

  /** Active admin with a password (bypasses the invitation flow). */
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

  /** User with 2FA switched on; returns the secret and the recovery codes. */
  async function makeTwoFactorUser(email: string) {
    const userId = await makeUser(email);
    const actor = { userId };
    const setup = await beginTotpSetup(ctx, actor);
    const { recoveryCodes } = await confirmTotpSetup(
      ctx,
      actor,
      PASSWORD,
      totpAt(setup.secret, Date.now()),
    );
    return { userId, secret: setup.secret, recoveryCodes };
  }

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
    const jobs = {
      add: async (_queue: string, _name: string, data: { messageId: string }) => {
        queued.push(data.messageId);
        return `job-${data.messageId}`;
      },
    } as unknown as JobQueues;
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example.org',
      secrets: secretBox,
      jobs,
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

  it('invites a user, accepts the link once and enforces the password policy', async () => {
    const { userId } = await inviteAdminUser(
      ctx,
      { userId: null },
      { email: 'Invitee@Example.org', displayName: 'Invitee', roles: ['FINANCE'], locale: 'de' },
    );
    const mail = (await mailsTo('invitee@example.org')).at(-1)!;
    expect(mail.key).toBe('ADMIN_INVITE');
    expect(mail.locale).toBe('de');
    expect(mail.variables.inviteUrl).toContain('/de/admin/accept-invite?token=');
    const token = tokenOf(mail.variables.inviteUrl);

    // Only the hash is stored.
    const [stored] = await handle.db
      .select()
      .from(adminTokens)
      .where(eq(adminTokens.userId, userId));
    expect(stored!.tokenHash).not.toContain(token);

    await expectCode(
      inviteAdminUser(
        ctx,
        { userId: null },
        { email: 'invitee@example.org', displayName: 'X', roles: ['FINANCE'], locale: 'en' },
      ),
      'EMAIL_TAKEN',
    );
    // Pending invites cannot sign in.
    expect((await checkAdminPassword(ctx, 'invitee@example.org', PASSWORD)).status).toBe('invalid');
    await expectCode(acceptAdminInvite(ctx, token, 'short'), 'WEAK_PASSWORD');
    expect(await isAdminTokenValid(ctx, token, 'INVITE')).toBe(true);
    expect(await isAdminTokenValid(ctx, token, 'PASSWORD_RESET')).toBe(false);

    await acceptAdminInvite(ctx, token, PASSWORD);
    await expectCode(acceptAdminInvite(ctx, token, PASSWORD), 'TOKEN_INVALID');
    expect(await isAdminTokenValid(ctx, token, 'INVITE')).toBe(false);
    const result = await checkAdminPassword(ctx, 'invitee@example.org', PASSWORD);
    expect(result).toMatchObject({ status: 'ok', userId, twoFactor: false });
    const users = await listAdminUsers(ctx);
    expect(users.find((u) => u.id === userId)).toMatchObject({
      invitePending: false,
      roles: ['FINANCE'],
    });
  });

  it('only the newest invitation link works and expired links are rejected', async () => {
    const { userId } = await inviteAdminUser(
      ctx,
      { userId: null },
      { email: 'twice@example.org', displayName: 'Twice', roles: ['DOOR_STAFF'], locale: 'en' },
    );
    await resendAdminInvite(ctx, { userId: null }, userId, 'en');
    const mails = await mailsTo('twice@example.org');
    expect(mails).toHaveLength(2);
    const [first, second] = mails.map((m) => tokenOf(m.variables.inviteUrl)) as [string, string];
    await expectCode(acceptAdminInvite(ctx, first, PASSWORD), 'TOKEN_INVALID');
    await handle.db
      .update(adminTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminTokens.userId, userId));
    await expectCode(acceptAdminInvite(ctx, second, PASSWORD), 'TOKEN_INVALID');
    // Never-accepted invitations can be deleted; accepted users cannot.
    await deleteAdminInvite(ctx, { userId: null }, userId);
    expect((await listAdminUsers(ctx)).some((u) => u.id === userId)).toBe(false);
    const accepted = await makeUser('accepted@example.org');
    await expectCode(deleteAdminInvite(ctx, { userId: null }, accepted), 'USER_HAS_SIGNED_IN');
  });

  it('locks the account after too many failures and unlocks on success after the lockout', async () => {
    await saveSetting(ctx, 'security', { maxFailedLogins: 3, lockoutMinutes: 10 }, null);
    const userId = await makeUser('lock@example.org');
    expect((await checkAdminPassword(ctx, 'lock@example.org', 'wrong-1')).status).toBe('invalid');
    expect((await checkAdminPassword(ctx, 'lock@example.org', 'wrong-2')).status).toBe('invalid');
    // A lock looks exactly like a wrong password; the correct one is refused while it lasts.
    expect(
      (await checkAdminPassword(ctx, 'lock@example.org', 'wrong-3', '203.0.113.7')).status,
    ).toBe('invalid');
    expect((await checkAdminPassword(ctx, 'lock@example.org', PASSWORD)).status).toBe('invalid');
    const [locked] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const trail = await handle.db.select().from(auditLogs).where(eq(auditLogs.actorUserId, userId));
    expect(trail.filter((l) => l.action === 'admin_user.login_failed')).toHaveLength(2);
    expect(trail.find((l) => l.action === 'admin_user.locked')?.ipAddress).toBe('203.0.113.7');
    await handle.db
      .update(adminUsers)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(adminUsers.id, userId));
    expect((await checkAdminPassword(ctx, 'lock@example.org', PASSWORD)).status).toBe('ok');
    // Nothing is stamped until the sign-in is completed.
    const [before] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(before!.lastLoginAt).toBeNull();
    await completeAdminLogin(ctx, userId, '203.0.113.9');
    const [after] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(after!.lastLoginAt).not.toBeNull();
    expect(after!.failedLoginCount).toBe(0);
    const logs = await handle.db.select().from(auditLogs).where(eq(auditLogs.actorUserId, userId));
    expect(logs.some((l) => l.action === 'admin_user.login')).toBe(true);
    // Unknown address behaves like a wrong password.
    expect((await checkAdminPassword(ctx, 'nobody@example.org', PASSWORD)).status).toBe('invalid');
    await saveSetting(ctx, 'security', {}, null);
  });

  it('password reset: neutral for unknown addresses, single use, expiring, ends sessions', async () => {
    const userId = await makeUser('reset@example.org');
    await handle.db.insert(adminSessions).values({
      tokenHash: `h-${randomUUID()}`,
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await requestAdminPasswordReset(ctx, 'unknown@example.org', 'en');
    expect(await mailsTo('unknown@example.org')).toHaveLength(0);

    await requestAdminPasswordReset(ctx, 'Reset@example.org', 'en');
    const mail = (await mailsTo('reset@example.org')).at(-1)!;
    expect(mail.key).toBe('ADMIN_PASSWORD_RESET');
    const token = tokenOf(mail.variables.resetUrl);
    await expectCode(resetAdminPassword(ctx, token, 'short'), 'WEAK_PASSWORD');
    await resetAdminPassword(ctx, token, 'a brand new passphrase');
    await expectCode(resetAdminPassword(ctx, token, 'another new passphrase'), 'TOKEN_INVALID');
    expect((await checkAdminPassword(ctx, 'reset@example.org', PASSWORD)).status).toBe('invalid');
    expect(
      (await checkAdminPassword(ctx, 'reset@example.org', 'a brand new passphrase')).status,
    ).toBe('ok');
    expect(
      await handle.db.select().from(adminSessions).where(eq(adminSessions.userId, userId)),
    ).toHaveLength(0);

    await requestAdminPasswordReset(ctx, 'reset@example.org', 'en');
    const second = tokenOf((await mailsTo('reset@example.org')).at(-1)!.variables.resetUrl);
    await handle.db
      .update(adminTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminTokens.userId, userId));
    await expectCode(resetAdminPassword(ctx, second, 'yet another passphrase'), 'TOKEN_INVALID');
  });

  it('enables two-factor only after a valid code and keeps the secret encrypted', async () => {
    const userId = await makeUser('setup@example.org');
    const setup = await beginTotpSetup(ctx, { userId });
    expect(setup.uri).toContain(setup.secret);
    expect(setup.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    let [row] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(row!.totpSecretEncrypted).toBeNull();
    expect(row!.totpPendingSecretEncrypted).not.toContain(setup.secret);
    expect(await checkAdminPassword(ctx, 'setup@example.org', PASSWORD)).toMatchObject({
      twoFactor: false,
    });
    await expectCode(confirmTotpSetup(ctx, { userId }, 'wrong', '000000'), 'WRONG_PASSWORD');
    await expectCode(confirmTotpSetup(ctx, { userId }, PASSWORD, '000000'), 'INVALID_CODE');
    await handle.db.insert(adminSessions).values([
      { tokenHash: 'setup-keep', userId, expiresAt: new Date(Date.now() + 3_600_000) },
      { tokenHash: 'setup-drop', userId, expiresAt: new Date(Date.now() + 3_600_000) },
    ]);
    const { recoveryCodes } = await confirmTotpSetup(
      ctx,
      { userId },
      PASSWORD,
      totpAt(setup.secret, Date.now()),
      'setup-keep',
    );
    const kept = await handle.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.userId, userId));
    expect(kept.map((x) => x.tokenHash)).toEqual(['setup-keep']);
    expect(kept[0]!.mfaVerifiedAt).not.toBeNull();
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    [row] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(row!.totpSecretEncrypted).not.toBeNull();
    expect(row!.totpPendingSecretEncrypted).toBeNull();
    expect(await checkAdminPassword(ctx, 'setup@example.org', PASSWORD)).toMatchObject({
      twoFactor: true,
    });
    await expectCode(beginTotpSetup(ctx, { userId }), 'TWO_FACTOR_ALREADY_ENABLED');
  });

  it('accepts a TOTP code once (replay protection) and recovery codes once', async () => {
    const { userId, secret, recoveryCodes } = await makeTwoFactorUser('second@example.org');
    // The setup consumed the current step: the same code is a replay.
    await expectCode(
      verifyAdminSecondFactor(ctx, userId, totpAt(secret, Date.now())),
      'INVALID_CODE',
    );
    const future = Date.now() + 30_000;
    expect(await verifyAdminSecondFactor(ctx, userId, totpAt(secret, future), future)).toBe('totp');
    await expectCode(
      verifyAdminSecondFactor(ctx, userId, totpAt(secret, future), future),
      'INVALID_CODE',
    );

    const code = recoveryCodes[3]!;
    expect(
      await verifyAdminSecondFactor(ctx, userId, code.toLowerCase().replaceAll('-', ' ')),
    ).toBe('recovery_code');
    await expectCode(verifyAdminSecondFactor(ctx, userId, code), 'INVALID_CODE');
    expect(normalizeRecoveryCode('abcd-efgh-ijkl-mnop')).toBe('ABCDEFGH1JK1MN0P');
  });

  it('counts wrong second-factor codes towards the lockout', async () => {
    await saveSetting(ctx, 'security', { maxFailedLogins: 3, lockoutMinutes: 10 }, null);
    const { userId } = await makeTwoFactorUser('brute@example.org');
    await expectCode(verifyAdminSecondFactor(ctx, userId, '111111'), 'INVALID_CODE');
    await expectCode(verifyAdminSecondFactor(ctx, userId, '222222'), 'INVALID_CODE');
    await expectCode(verifyAdminSecondFactor(ctx, userId, '333333'), 'ACCOUNT_LOCKED');
    await expectCode(verifyAdminSecondFactor(ctx, userId, '444444'), 'ACCOUNT_LOCKED');
    await saveSetting(ctx, 'security', {}, null);
  });

  it('disable needs password and code, is refused when 2FA is mandatory, and reset clears it', async () => {
    const { userId, secret } = await makeTwoFactorUser('disable@example.org');
    const future = Date.now() + 90_000;
    await expectCode(
      disableTotp(ctx, { userId }, 'wrong password', totpAt(secret, future)),
      'WRONG_PASSWORD',
    );
    await saveSetting(ctx, 'security', { requireTwoFactor: true }, null);
    await expectCode(
      disableTotp(ctx, { userId }, PASSWORD, totpAt(secret, future)),
      'TWO_FACTOR_REQUIRED',
    );
    await saveSetting(ctx, 'security', { requireTwoFactor: false }, null);

    await resetAdminTwoFactor(ctx, { userId: null }, userId);
    const [row] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(row!.totpSecretEncrypted).toBeNull();
    expect(row!.totpLastStep).toBeNull();
    expect(await checkAdminPassword(ctx, 'disable@example.org', PASSWORD)).toMatchObject({
      twoFactor: false,
    });
  });

  it('changing the own password keeps only the current session', async () => {
    const userId = await makeUser('change@example.org');
    await handle.db.insert(adminSessions).values([
      { tokenHash: 'keep-me', userId, expiresAt: new Date(Date.now() + 3_600_000) },
      { tokenHash: 'drop-me', userId, expiresAt: new Date(Date.now() + 3_600_000) },
    ]);
    await expectCode(
      changeOwnPassword(ctx, { userId }, 'nope', 'a brand new passphrase', 'keep-me'),
      'WRONG_PASSWORD',
    );
    await changeOwnPassword(ctx, { userId }, PASSWORD, 'a brand new passphrase', 'keep-me');
    const left = await handle.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.userId, userId));
    expect(left.map((s) => s.tokenHash)).toEqual(['keep-me']);
  });

  it('never lets the last active super admin go, even concurrently', async () => {
    // Isolate: deactivate every other super admin from earlier tests.
    await handle.db
      .update(adminUsers)
      .set({ isActive: false })
      .where(sql`'SUPER_ADMIN' = ANY(${adminUsers.roles})`);
    const a = await makeUser('root-a@example.org', ['SUPER_ADMIN']);
    const actor = { userId: null };
    await expectCode(setAdminUserActive(ctx, actor, a, false), 'LAST_SUPER_ADMIN');
    await expectCode(
      updateAdminUser(ctx, actor, a, { displayName: 'A', roles: ['EVENT_MANAGER'] }),
      'LAST_SUPER_ADMIN',
    );
    await expectCode(setAdminUserActive(ctx, { userId: a }, a, false), 'CANNOT_DEACTIVATE_SELF');

    // A pending invitation is not a usable super admin.
    await inviteAdminUser(ctx, actor, {
      email: 'root-pending@example.org',
      displayName: 'P',
      roles: ['SUPER_ADMIN'],
      locale: 'en',
    });
    await expectCode(setAdminUserActive(ctx, actor, a, false), 'LAST_SUPER_ADMIN');

    // Two super admins demoting each other at the same time: exactly one succeeds.
    const b = await makeUser('root-b@example.org', ['SUPER_ADMIN']);
    const results = await Promise.allSettled([
      updateAdminUser(ctx, actor, a, { displayName: 'A', roles: ['FINANCE'] }),
      updateAdminUser(ctx, actor, b, { displayName: 'B', roles: ['FINANCE'] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as DomainError).code).toBe('LAST_SUPER_ADMIN');
    const supers = (await listAdminUsers(ctx)).filter(
      (u) => u.isActive && !u.invitePending && u.roles.includes('SUPER_ADMIN'),
    );
    expect(supers).toHaveLength(1);
  });

  it('a role change or deactivation ends the sessions of that user', async () => {
    const userId = await makeUser('sessions@example.org');
    const add = () =>
      handle.db.insert(adminSessions).values({
        tokenHash: `s-${randomUUID()}`,
        userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    await add();
    await updateAdminUser(ctx, { userId: null }, userId, { displayName: 'S', roles: ['FINANCE'] });
    expect(
      await handle.db.select().from(adminSessions).where(eq(adminSessions.userId, userId)),
    ).toHaveLength(0);
    await add();
    await setAdminUserActive(ctx, { userId: null }, userId, false);
    expect(
      await handle.db.select().from(adminSessions).where(eq(adminSessions.userId, userId)),
    ).toHaveLength(0);
    expect((await checkAdminPassword(ctx, 'sessions@example.org', PASSWORD)).status).toBe(
      'invalid',
    );
    await setAdminUserActive(ctx, { userId: null }, userId, true);
    expect((await checkAdminPassword(ctx, 'sessions@example.org', PASSWORD)).status).toBe('ok');
  });

  it('parallel wrong guesses never clear or extend an active lockout', async () => {
    await saveSetting(ctx, 'security', { maxFailedLogins: 3, lockoutMinutes: 10 }, null);
    const userId = await makeUser('race@example.org');
    for (const guess of ['a', 'b', 'c']) await checkAdminPassword(ctx, 'race@example.org', guess);
    const [locked] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    const until = locked!.lockedUntil!.getTime();
    expect(until).toBeGreaterThan(Date.now());
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => checkAdminPassword(ctx, 'race@example.org', `x${i}`)),
    );
    // Second-factor style failures go through the same guard.
    const [after] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    expect(after!.lockedUntil!.getTime()).toBe(until);
    expect(after!.failedLoginCount).toBe(0);
    await saveSetting(ctx, 'security', {}, null);
  });

  it('lets a super admin unlock a user and deactivation drops open links', async () => {
    await saveSetting(ctx, 'security', { maxFailedLogins: 3, lockoutMinutes: 10 }, null);
    const userId = await makeUser('unlock@example.org');
    for (const guess of ['a', 'b', 'c']) await checkAdminPassword(ctx, 'unlock@example.org', guess);
    expect((await checkAdminPassword(ctx, 'unlock@example.org', PASSWORD)).status).toBe('invalid');
    await unlockAdminUser(ctx, { userId: null }, userId);
    expect((await checkAdminPassword(ctx, 'unlock@example.org', PASSWORD)).status).toBe('ok');
    await requestAdminPasswordReset(ctx, 'unlock@example.org', 'en');
    expect(
      await handle.db.select().from(adminTokens).where(eq(adminTokens.userId, userId)),
    ).toHaveLength(1);
    await setAdminUserActive(ctx, { userId: null }, userId, false);
    expect(
      await handle.db.select().from(adminTokens).where(eq(adminTokens.userId, userId)),
    ).toHaveLength(0);
    await saveSetting(ctx, 'security', {}, null);
  });

  it('answers a concurrent duplicate invitation with EMAIL_TAKEN', async () => {
    const invite = () =>
      inviteAdminUser(
        ctx,
        { userId: null },
        { email: 'dup@example.org', displayName: 'Dup', roles: ['FINANCE'], locale: 'en' },
      );
    const results = await Promise.allSettled([invite(), invite()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as DomainError).code).toBe('EMAIL_TAKEN');
  });
});
