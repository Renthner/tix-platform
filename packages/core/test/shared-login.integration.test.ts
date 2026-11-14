/**
 * Shared shop sign-in (customer + admin accounts behind one form) and the admin → customer
 * link, against real PostgreSQL + Redis (throwaway database): which account a password
 * belongs to, who is charged for a failure, that nothing opens a session before the second
 * factor and that a pre-registered customer row cannot be used to take over an admin's
 * customer account.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  adminSessions,
  adminUsers,
  auditLogs,
  emailMessages,
  createDb,
  customerSessions,
  customerTokens,
  customers,
  loadRootEnv,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, hashPassword, parseKeyRing, totpAt } from '@tix/shared/server';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  EMAIL_VARIABLES_CONTEXT,
  authenticateCustomer,
  checkCustomerPassword,
  isAdminEmailVerificationValid,
  parseStoredEmailRequest,
  requestAdminEmailVerification,
  resetAdminTwoFactor,
  safeReturnPath,
  verifyAdminEmail,
  verifyCustomerEmail,
  beginTotpSetup,
  checkAdminPassword,
  checkSharedLogin,
  confirmTotpSetup,
  createCoreContext,
  createCustomerSession,
  isLinkedPair,
  linkCustomerForAdmin,
  registerCustomer,
  resolveCustomerSession,
  saveSetting,
  setAdminUserActive,
  splitDisplayName,
  type CoreContext,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const ADMIN_PASSWORD = 'admin horse battery';
const CUSTOMER_PASSWORD = 'customer horse battery';
const ATTACKER_PASSWORD = 'attacker horse battery';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return (err as DomainError).code;
}

describe('safeReturnPath', () => {
  it('rejects protocol-relative results after normalisation and locale stripping', () => {
    for (const evil of [
      '//evil.example',
      '/en//evil.example',
      '/de//evil.example/x',
      '/.//evil.example',
      '/x/..//evil.example',
      '/%2e%2e//evil.example',
      '/en/\\evil.example',
      '/\\evil.example',
      'https://evil.example',
    ]) {
      expect(safeReturnPath(evil), evil).toBeNull();
    }
    expect(safeReturnPath('/de/checkout?step=2')).toBe('/checkout?step=2');
    expect(safeReturnPath('/en')).toBe('/');
    expect(safeReturnPath('/en?x=1')).toBe('/?x=1');
  });
});

describe('pure helpers', () => {
  it('splits display names and pairs accounts by e-mail', () => {
    expect(splitDisplayName('Erika Mustermann')).toEqual({
      firstName: 'Erika',
      lastName: 'Mustermann',
    });
    expect(splitDisplayName('  Anna Maria  von Test ')).toEqual({
      firstName: 'Anna',
      lastName: 'Maria von Test',
    });
    expect(splitDisplayName('Cher')).toEqual({ firstName: 'Cher', lastName: '-' });
    expect(isLinkedPair(' Erika@Example.org', 'erika@example.ORG ')).toBe(true);
    expect(isLinkedPair('a@example.org', 'b@example.org')).toBe(false);
  });
});

describe.skipIf(!adminUrl || !redisUrl)('shared sign-in (integration)', () => {
  const dbName = `tix_sharedlogin_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let counter = 0;
  const fresh = (prefix: string) => `${prefix}${++counter}@example.org`;

  async function makeAdmin(
    email: string,
    options: { password?: string; displayName?: string; verified?: boolean } = {},
  ): Promise<string> {
    const [row] = await handle.db
      .insert(adminUsers)
      .values({
        email,
        displayName: options.displayName ?? 'Erika Mustermann',
        roles: ['EVENT_MANAGER'],
        emailVerifiedAt: options.verified === false ? null : new Date(),
        passwordHash: await hashPassword(options.password ?? ADMIN_PASSWORD),
      })
      .returning({ id: adminUsers.id });
    return row!.id;
  }

  /** Verified customer account with a password. */
  async function makeCustomer(email: string, password = CUSTOMER_PASSWORD): Promise<string> {
    const [row] = await handle.db
      .insert(customers)
      .values({
        email,
        firstName: 'Cu',
        lastName: 'Stomer',
        passwordHash: await hashPassword(password),
        accountCreatedAt: new Date(),
        emailVerifiedAt: new Date(),
      })
      .returning({ id: customers.id });
    return row!.id;
  }

  const adminRow = async (id: string) =>
    (await handle.db.select().from(adminUsers).where(eq(adminUsers.id, id)))[0]!;
  const customerRow = async (id: string) =>
    (await handle.db.select().from(customers).where(eq(customers.id, id)))[0]!;
  const sessionCount = async () => ({
    admin: (await handle.db.select().from(adminSessions)).length,
    customer: (await handle.db.select().from(customerSessions)).length,
  });

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
      add: async (_queue: string, _name: string, data: { messageId: string }) =>
        `job-${data.messageId}`,
    } as unknown as JobQueues;
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example.org',
      secrets: createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`)),
      jobs,
    });
    await saveSetting(ctx, 'customerAccounts', { enabled: true }, null);
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

  // ─── Which account a password belongs to ─────────────────────────────────────────────

  it('admin password → admin result; opens no session of any kind', async () => {
    const email = fresh('admin-only');
    const userId = await makeAdmin(email);
    const before = await sessionCount();
    const result = await checkSharedLogin(ctx, {
      email: email.toUpperCase(),
      password: ADMIN_PASSWORD,
    });
    expect(result.kind).toBe('admin');
    if (result.kind === 'admin') expect(result.admin.userId).toBe(userId);
    expect(await sessionCount()).toEqual(before);
    // A customer row was not created by merely checking the password.
    expect(await handle.db.select().from(customers).where(eq(customers.email, email))).toHaveLength(
      0,
    );
  });

  it('admin with two-factor: the check opens no session and reports the second factor', async () => {
    const email = fresh('admin-2fa');
    const userId = await makeAdmin(email);
    const setup = await beginTotpSetup(ctx, { userId });
    await confirmTotpSetup(ctx, { userId }, ADMIN_PASSWORD, totpAt(setup.secret, Date.now()));
    const before = await sessionCount();
    const result = await checkSharedLogin(ctx, { email, password: ADMIN_PASSWORD });
    expect(result.kind).toBe('admin');
    if (result.kind === 'admin') expect(result.admin.twoFactor).toBe(true);
    expect(await sessionCount()).toEqual(before);
    // …and nothing linked a customer account yet.
    expect(await handle.db.select().from(customers).where(eq(customers.email, email))).toHaveLength(
      0,
    );
  });

  it('customer password only → customer result and never charged to the admin lockout', async () => {
    const email = fresh('both');
    const userId = await makeAdmin(email);
    const customerId = await makeCustomer(email);
    // More successful customer sign-ins than the lockout limit (default 5).
    for (let i = 0; i < 8; i += 1) {
      const result = await checkSharedLogin(ctx, { email, password: CUSTOMER_PASSWORD });
      expect(result).toMatchObject({ kind: 'customer', customerId });
    }
    const row = await adminRow(userId);
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect((await customerRow(customerId)).failedLoginCount).toBe(0);
  });

  it('both passwords equal → admin result', async () => {
    const email = fresh('same-password');
    await makeAdmin(email, { password: ADMIN_PASSWORD });
    await makeCustomer(email, ADMIN_PASSWORD);
    expect((await checkSharedLogin(ctx, { email, password: ADMIN_PASSWORD })).kind).toBe('admin');
  });

  it('a locked admin account does not block the customer password (and stays locked)', async () => {
    const email = fresh('locked-admin');
    const userId = await makeAdmin(email);
    await makeCustomer(email);
    await handle.db
      .update(adminUsers)
      .set({ lockedUntil: sql`now() + interval '10 minutes'` })
      .where(eq(adminUsers.id, userId));
    expect((await checkSharedLogin(ctx, { email, password: CUSTOMER_PASSWORD })).kind).toBe(
      'customer',
    );
    // The admin password does not help while locked – it just fails like any wrong password.
    const locked = await checkSharedLogin(ctx, { email, password: ADMIN_PASSWORD });
    expect(locked.kind).toBe('invalid');
  });

  // ─── Failure counting ────────────────────────────────────────────────────────────────

  it('neither password matches → charged to both accounts, locks both after the limit', async () => {
    const email = fresh('neither');
    const userId = await makeAdmin(email);
    const customerId = await makeCustomer(email);
    const first = await checkSharedLogin(ctx, { email, password: 'nope nope nope' });
    expect(first.kind).toBe('invalid');
    expect((await adminRow(userId)).failedLoginCount).toBe(1);
    expect((await customerRow(customerId)).failedLoginCount).toBe(1);
    for (let i = 0; i < 4; i += 1)
      await checkSharedLogin(ctx, { email, password: 'nope nope nope' });
    expect((await adminRow(userId)).lockedUntil).not.toBeNull();
    expect((await customerRow(customerId)).lockedUntil).not.toBeNull();
  });

  it('known and unknown addresses show the same error sequence (no enumeration)', async () => {
    const adminEmail = fresh('seq-admin');
    await makeAdmin(adminEmail);
    const unknownEmail = fresh('seq-unknown');
    const sequence = async (email: string) => {
      const codes: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const result = await checkSharedLogin(ctx, { email, password: 'wrong wrong wrong' });
        expect(result.kind).toBe('invalid');
        codes.push(result.kind === 'invalid' ? result.error.code : 'ok');
      }
      return codes;
    };
    const known = await sequence(adminEmail);
    const unknown = await sequence(unknownEmail);
    expect(known).toEqual(unknown);
    expect(known[0]).toBe('INVALID_CREDENTIALS');
    expect(known).toContain('ACCOUNT_LOCKED');
  });

  it('the admin portal form keeps counting every wrong password itself', async () => {
    const email = fresh('portal');
    const userId = await makeAdmin(email);
    await makeCustomer(email);
    expect(await checkAdminPassword(ctx, email, CUSTOMER_PASSWORD)).toEqual({ status: 'invalid' });
    expect((await adminRow(userId)).failedLoginCount).toBe(1);
  });

  it('a successful admin sign-in resets nothing it should not and never needs a customer row', async () => {
    const email = fresh('no-customer');
    await makeAdmin(email);
    expect((await checkSharedLogin(ctx, { email, password: 'wrong wrong wrong' })).kind).toBe(
      'invalid',
    );
    expect((await checkSharedLogin(ctx, { email, password: ADMIN_PASSWORD })).kind).toBe('admin');
  });

  // ─── Linking ─────────────────────────────────────────────────────────────────────────

  it('creates a verified customer for an admin without one (names from the display name)', async () => {
    const email = fresh('link-new');
    const userId = await makeAdmin(email, { displayName: 'Erika Mustermann' });
    const linked = await linkCustomerForAdmin(ctx, userId);
    expect(linked).not.toBeNull();
    const row = await customerRow(linked!.customerId);
    expect(row).toMatchObject({
      email,
      firstName: 'Erika',
      lastName: 'Mustermann',
      passwordHash: null,
    });
    expect(row.accountCreatedAt).not.toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();
    // Idempotent.
    expect(await linkCustomerForAdmin(ctx, userId)).toMatchObject({
      customerId: linked!.customerId,
      created: false,
    });
    const session = await createCustomerSession(ctx, linked!.customerId);
    expect((await resolveCustomerSession(ctx, session.token))?.emailVerified).toBe(true);
  });

  it('keeps password and sessions of an already verified customer account', async () => {
    const email = fresh('link-verified');
    const userId = await makeAdmin(email);
    const customerId = await makeCustomer(email);
    const session = await createCustomerSession(ctx, customerId);
    expect(await linkCustomerForAdmin(ctx, userId)).toMatchObject({ customerId });
    expect(await resolveCustomerSession(ctx, session.token)).not.toBeNull();
    expect(await authenticateCustomer(ctx, { email, password: CUSTOMER_PASSWORD })).toEqual({
      customerId,
    });
  });

  it('activates a guest customer row (earlier guest orders belong to the admin address)', async () => {
    const email = fresh('link-guest');
    const userId = await makeAdmin(email);
    const [guest] = await handle.db
      .insert(customers)
      .values({ email, firstName: 'Guest', lastName: 'Buyer' })
      .returning({ id: customers.id });
    expect(await linkCustomerForAdmin(ctx, userId)).toMatchObject({ customerId: guest!.id });
    const row = await customerRow(guest!.id);
    expect(row.accountCreatedAt).not.toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.firstName).toBe('Guest');
  });

  it('SECURITY: a pre-registered, unverified customer account cannot be used after the link', async () => {
    const email = fresh('takeover');
    const userId = await makeAdmin(email);
    // The attacker registers the admin's address with their own password and signs in
    // (sign-in works before the address is confirmed).
    await registerCustomer(ctx, {
      firstName: 'Mallory',
      lastName: 'Attacker',
      email,
      password: ATTACKER_PASSWORD,
      locale: 'en',
    });
    const attackerRow = (
      await handle.db.select().from(customers).where(eq(customers.email, email))
    )[0]!;
    expect(attackerRow.emailVerifiedAt).toBeNull();
    const { customerId } = await authenticateCustomer(ctx, { email, password: ATTACKER_PASSWORD });
    const attackerSession = await createCustomerSession(ctx, customerId);
    expect(await resolveCustomerSession(ctx, attackerSession.token)).not.toBeNull();
    expect(
      await handle.db
        .select()
        .from(customerTokens)
        .where(eq(customerTokens.customerId, customerId)),
    ).not.toHaveLength(0);

    const linked = await linkCustomerForAdmin(ctx, userId);
    expect(linked).toMatchObject({ customerId });

    // Password, session and the pending verification token are gone; the row is verified now.
    expect(await codeOf(authenticateCustomer(ctx, { email, password: ATTACKER_PASSWORD }))).toBe(
      'INVALID_CREDENTIALS',
    );
    expect(await resolveCustomerSession(ctx, attackerSession.token)).toBeNull();
    expect(
      await handle.db
        .select()
        .from(customerTokens)
        .where(eq(customerTokens.customerId, customerId)),
    ).toHaveLength(0);
    const row = await customerRow(customerId);
    expect(row.passwordHash).toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();
    // The shared sign-in form no longer accepts the attacker's password for anything either.
    expect((await checkSharedLogin(ctx, { email, password: ATTACKER_PASSWORD })).kind).toBe(
      'invalid',
    );
  });

  it('does not link when accounts are off, the admin is inactive or the customer is anonymised', async () => {
    const off = fresh('link-off');
    const offId = await makeAdmin(off);
    await saveSetting(ctx, 'customerAccounts', { enabled: false }, null);
    expect(await linkCustomerForAdmin(ctx, offId)).toBeNull();
    await saveSetting(ctx, 'customerAccounts', { enabled: true }, null);
    // Checking passwords still works for admins while customer accounts are off.
    await saveSetting(ctx, 'customerAccounts', { enabled: false }, null);
    expect((await checkSharedLogin(ctx, { email: off, password: ADMIN_PASSWORD })).kind).toBe(
      'admin',
    );
    await saveSetting(ctx, 'customerAccounts', { enabled: true }, null);

    const inactive = fresh('link-inactive');
    const inactiveId = await makeAdmin(inactive);
    await setAdminUserActive(ctx, { userId: null }, inactiveId, false);
    expect(await linkCustomerForAdmin(ctx, inactiveId)).toBeNull();

    const anon = fresh('link-anon');
    const anonId = await makeAdmin(anon);
    // Anonymisation replaces the e-mail by a placeholder, so the admin's address gets a fresh row.
    const [erased] = await handle.db
      .insert(customers)
      .values({
        email: `erased-${randomUUID()}@anonymized.invalid`,
        firstName: 'x',
        lastName: 'x',
        anonymizedAt: new Date(),
      })
      .returning({ id: customers.id });
    const fresh1 = await linkCustomerForAdmin(ctx, anonId);
    expect(fresh1).not.toBeNull();
    expect(fresh1!.customerId).not.toBe(erased!.id);
    expect(fresh1!.created).toBe(true);
  });

  it('links only admins whose e-mail address is verified; audits the link', async () => {
    const email = fresh('link-unverified');
    const userId = await makeAdmin(email, { verified: false });
    expect(await linkCustomerForAdmin(ctx, userId)).toBeNull();
    expect(await handle.db.select().from(customers).where(eq(customers.email, email))).toHaveLength(
      0,
    );
    // The admin password still works for the shared form.
    expect((await checkSharedLogin(ctx, { email, password: ADMIN_PASSWORD })).kind).toBe('admin');
    await handle.db
      .update(adminUsers)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(adminUsers.id, userId));
    const linked = await linkCustomerForAdmin(ctx, userId);
    expect(linked).toMatchObject({ created: true, provisionalDiscarded: false });
    const audit = await handle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'admin_user.customer_link'));
    expect(audit.some((a) => a.entityId === userId)).toBe(true);
  });

  it('verifies the admin e-mail address with a one-time link (invite/reset also prove it)', async () => {
    const email = fresh('verify-admin');
    const userId = await makeAdmin(email, { verified: false });
    expect(await requestAdminEmailVerification(ctx, { userId }, 'en')).toEqual({
      alreadyVerified: false,
    });
    const [message] = await handle.db
      .select({ payload: emailMessages.attachments, key: emailMessages.templateKey })
      .from(emailMessages)
      .where(eq(emailMessages.toEmail, email));
    expect(message!.key).toBe('CUSTOMER_EMAIL_VERIFICATION');
    const stored = parseStoredEmailRequest(message!.payload);
    const variables = ctx.secrets!.decryptJson<Record<string, string>>(
      stored.variables!,
      EMAIL_VARIABLES_CONTEXT,
    );
    expect(variables.verificationUrl).toContain('/admin/verify-email?token=');
    const token = new URL(variables.verificationUrl!).searchParams.get('token')!;
    expect(await isAdminEmailVerificationValid(ctx, token)).toBe(true);
    await verifyAdminEmail(ctx, token);
    expect((await adminRow(userId)).emailVerifiedAt).not.toBeNull();
    expect(await codeOf(verifyAdminEmail(ctx, token))).toBe('TOKEN_INVALID');
    expect(await requestAdminEmailVerification(ctx, { userId }, 'en')).toEqual({
      alreadyVerified: true,
    });
  });

  // ─── Locked accounts, session tagging, races ─────────────────────────────────────────

  it('a right password of a locked account is not charged as a failure to the other account', async () => {
    const email = fresh('locked-match');
    const adminId = await makeAdmin(email);
    const customerId = await makeCustomer(email);
    await handle.db
      .update(adminUsers)
      .set({ lockedUntil: sql`now() + interval '10 minutes'`, failedLoginCount: 0 })
      .where(eq(adminUsers.id, adminId));
    // Right admin password while locked: refused, customer row untouched.
    expect((await checkSharedLogin(ctx, { email, password: ADMIN_PASSWORD })).kind).toBe('invalid');
    expect((await customerRow(customerId)).failedLoginCount).toBe(0);
    // Customer locked, right customer password: refused, admin counter untouched.
    await handle.db.update(adminUsers).set({ lockedUntil: null }).where(eq(adminUsers.id, adminId));
    await handle.db
      .update(customers)
      .set({ lockedUntil: sql`now() + interval '10 minutes'` })
      .where(eq(customers.id, customerId));
    const result = await checkSharedLogin(ctx, { email, password: CUSTOMER_PASSWORD });
    expect(result.kind).toBe('invalid');
    expect((await adminRow(adminId)).failedLoginCount).toBe(0);
    // …but the (unlocked) admin password still signs in.
    expect((await checkSharedLogin(ctx, { email, password: ADMIN_PASSWORD })).kind).toBe('admin');
  });

  it('link-created sessions are capped, tagged and revoked with the admin; own sessions survive', async () => {
    const email = fresh('tagged');
    const userId = await makeAdmin(email);
    const customerId = await makeCustomer(email);
    const own = await createCustomerSession(ctx, customerId);
    const cap = new Date(Date.now() + 60 * 60_000);
    const linked = await createCustomerSession(
      ctx,
      customerId,
      {},
      { linkedAdminUserId: userId, cap },
    );
    expect(linked.expiresAt.getTime()).toBeLessThanOrEqual(cap.getTime());
    expect(linked.maxAgeSeconds).toBeLessThanOrEqual(3600);
    expect((await resolveCustomerSession(ctx, linked.token))?.linkedAdminUserId).toBe(userId);
    expect((await resolveCustomerSession(ctx, own.token))?.linkedAdminUserId).toBeNull();
    await resetAdminTwoFactor(ctx, { userId: null }, userId);
    expect(await resolveCustomerSession(ctx, linked.token)).toBeNull();
    expect(await resolveCustomerSession(ctx, own.token)).not.toBeNull();
  });

  it('refuses a session when the verified password hash changed meanwhile', async () => {
    const email = fresh('hash-race');
    const customerId = await makeCustomer(email);
    const check = await checkCustomerPassword(ctx, { email, password: CUSTOMER_PASSWORD });
    expect(check.status).toBe('ok');
    if (check.status !== 'ok') return;
    await handle.db
      .update(customers)
      .set({ passwordHash: null })
      .where(eq(customers.id, customerId));
    expect(
      await codeOf(
        createCustomerSession(ctx, customerId, {}, { requirePasswordHash: check.passwordHash }),
      ),
    ).toBe('INVALID_CREDENTIALS');
  });

  it('first e-mail verification discards a pre-set password unless the registrant verifies', async () => {
    const mailTokenOf = async (to: string) => {
      const rows = await handle.db
        .select({ payload: emailMessages.attachments })
        .from(emailMessages)
        .where(eq(emailMessages.toEmail, to));
      const stored = parseStoredEmailRequest(rows.at(-1)!.payload);
      const vars = ctx.secrets!.decryptJson<Record<string, string>>(
        stored.variables!,
        EMAIL_VARIABLES_CONTEXT,
      );
      return new URL(vars.verificationUrl!).searchParams.get('token')!;
    };
    const register = (email: string) =>
      registerCustomer(ctx, {
        firstName: 'M',
        lastName: 'A',
        email,
        password: ATTACKER_PASSWORD,
        locale: 'en',
      });
    // Somebody else verifies (no session of the account): password + sessions are gone.
    const a = fresh('verify-other');
    await register(a);
    const aId = (await authenticateCustomer(ctx, { email: a, password: ATTACKER_PASSWORD }))
      .customerId;
    const aSession = await createCustomerSession(ctx, aId);
    const result = await verifyCustomerEmail(ctx, await mailTokenOf(a));
    expect(result.passwordCleared).toBe(true);
    expect(await resolveCustomerSession(ctx, aSession.token)).toBeNull();
    expect(await codeOf(authenticateCustomer(ctx, { email: a, password: ATTACKER_PASSWORD }))).toBe(
      'INVALID_CREDENTIALS',
    );
    // The registrant confirms in the browser they are signed in with: password stays.
    const b = fresh('verify-self');
    await register(b);
    const bId = (await authenticateCustomer(ctx, { email: b, password: ATTACKER_PASSWORD }))
      .customerId;
    const bSession = await createCustomerSession(ctx, bId);
    const other = await createCustomerSession(ctx, bId);
    const own = await verifyCustomerEmail(ctx, await mailTokenOf(b), {
      sessionToken: bSession.token,
    });
    expect(own.passwordCleared).toBe(false);
    expect(await resolveCustomerSession(ctx, bSession.token)).not.toBeNull();
    expect(await resolveCustomerSession(ctx, other.token)).toBeNull();
    await authenticateCustomer(ctx, { email: b, password: ATTACKER_PASSWORD });
  });
});
