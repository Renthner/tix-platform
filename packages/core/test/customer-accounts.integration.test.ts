/**
 * Customer accounts against real PostgreSQL + Redis: registration (new address, guest
 * upgrade, existing account), e-mail verification, password login + lockout, login links,
 * password reset, sessions, profile, order visibility. E-mails go through the real outbox
 * (`email_messages`); the BullMQ producer is stubbed, links are read from the encrypted
 * variables of the stored message.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDb,
  customerSessions,
  customerTokens,
  customers,
  emailMessages,
  events,
  loadRootEnv,
  orderItems,
  orders,
  priceCategories,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { asc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  EMAIL_VARIABLES_CONTEXT,
  authenticateCustomer,
  changeCustomerPassword,
  consumeLoginLink,
  createCoreContext,
  createCustomerSession,
  isPasswordResetTokenValid,
  listCustomerOrders,
  parseStoredEmailRequest,
  registerCustomer,
  requestLoginLink,
  requestPasswordReset,
  resetCustomerPassword,
  resolveCustomerSession,
  revokeCustomerSession,
  safeReturnPath,
  saveSetting,
  sendEmailVerification,
  updateCustomerProfile,
  verifyCustomerEmail,
  type CoreContext,
  type JobQueues,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const uuid = () => randomUUID();
const PASSWORD = 'correct horse battery';
const APP_URL = 'https://shop.example.org';

/** Rejects with a DomainError of `code` (optionally checking details). */
async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  return err as DomainError;
}

describe.skipIf(!adminUrl || !redisUrl)('customer accounts (integration)', () => {
  const dbName = `tix_accounts_${Date.now()}_${uuid().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  const queued: string[] = [];

  /** Account e-mails sent to an address (oldest first) with decrypted variables. */
  async function mailsTo(email: string) {
    const rows = await handle.db
      .select({
        id: emailMessages.id,
        key: emailMessages.templateKey,
        payload: emailMessages.attachments,
      })
      .from(emailMessages)
      .where(sql`lower(${emailMessages.toEmail}) = ${email.toLowerCase()}`)
      .orderBy(asc(emailMessages.createdAt), asc(emailMessages.id));
    return rows.map((row) => {
      const stored = parseStoredEmailRequest(row.payload);
      const variables = stored.variables
        ? ctx.secrets!.decryptJson<Record<string, string>>(
            stored.variables,
            EMAIL_VARIABLES_CONTEXT,
          )
        : {};
      return { id: row.id, key: row.key, locale: stored.locale, variables };
    });
  }

  async function lastMail(email: string) {
    const mails = await mailsTo(email);
    const mail = mails.at(-1);
    if (!mail) throw new Error(`no mail to ${email}`);
    return mail;
  }

  const tokenOf = (url: string | undefined) => new URL(url!).searchParams.get('token')!;

  async function setAccounts(value: Record<string, unknown>) {
    await saveSetting(ctx, 'customerAccounts', value, null);
  }

  /** Registered + verified account, returns its id. */
  async function verifiedAccount(email: string, password = PASSWORD): Promise<string> {
    await registerCustomer(ctx, {
      firstName: 'Test',
      lastName: 'User',
      email,
      password,
      locale: 'en',
    });
    const mail = await lastMail(email);
    // Confirmed from the registrant's own signed-in browser (otherwise the password is dropped).
    const auth = await authenticateCustomer(ctx, { email, password });
    const own = await createCustomerSession(ctx, auth.customerId);
    const { customerId } = await verifyCustomerEmail(ctx, tokenOf(mail.variables.verificationUrl), {
      sessionToken: own.token,
    });
    await revokeCustomerSession(ctx, own.token);
    return customerId;
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
      keyPrefix: `t${uuid().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      appUrl: APP_URL,
      secrets: createSecretBox(parseKeyRing(`t1:${randomBytes(32).toString('base64')}`)),
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

  it('accepts only same-origin relative return paths', () => {
    expect(safeReturnPath('/checkout')).toBe('/checkout');
    expect(safeReturnPath('/de/checkout?step=2')).toBe('/checkout?step=2');
    expect(safeReturnPath('/en')).toBe('/');
    expect(safeReturnPath('/events/gala#seats')).toBe('/events/gala#seats');
    expect(safeReturnPath('/dealer')).toBe('/dealer');
    for (const bad of [
      '//evil.example',
      'https://evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      'checkout',
      '/a\nb',
      '',
      null,
      42,
    ]) {
      expect(safeReturnPath(bad), String(bad)).toBeNull();
    }
  });

  it('registers, verifies the e-mail address and signs in', async () => {
    const email = 'ada.register@example.invalid';
    await registerCustomer(ctx, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: '  Ada.Register@Example.INVALID ',
      password: PASSWORD,
      locale: 'de',
      returnPath: '/de/checkout?step=2',
    });
    const [row] = await handle.db.select().from(customers).where(eq(customers.email, email));
    expect(row).toMatchObject({ firstName: 'Ada', locale: 'de', emailVerifiedAt: null });
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.accountCreatedAt).toBeInstanceOf(Date);

    const mail = await lastMail(email);
    expect(mail.key).toBe('CUSTOMER_EMAIL_VERIFICATION');
    expect(mail.locale).toBe('de');
    expect(mail.variables.firstName).toBe('Ada');
    const link = new URL(mail.variables.verificationUrl!);
    expect(`${link.origin}${link.pathname}`).toBe(`${APP_URL}/de/account/verify`);
    expect(link.searchParams.get('next')).toBe('/checkout?step=2');
    expect(queued).toContain(mail.id);

    await expectCode(
      authenticateCustomer(ctx, { email, password: 'wrong password!' }),
      'INVALID_CREDENTIALS',
    );
    const { customerId } = await authenticateCustomer(ctx, {
      email: 'ADA.register@example.invalid',
      password: PASSWORD,
    });
    expect(customerId).toBe(row!.id);

    const session = await createCustomerSession(ctx, customerId, {
      ipAddress: 'not-an-ip',
      userAgent: 'vitest',
    });
    expect(session.maxAgeSeconds).toBe(30 * 86_400);
    let resolved = await resolveCustomerSession(ctx, session.token);
    expect(resolved).toMatchObject({ customerId, emailVerified: false, hasPassword: true });

    const token = tokenOf(mail.variables.verificationUrl);
    // The registrant confirms in the browser they are signed in with: password and session stay.
    expect(await verifyCustomerEmail(ctx, token, { sessionToken: session.token })).toEqual({
      customerId,
      alreadyVerified: false,
      passwordCleared: false,
    });
    // Opened again (or by a mail scanner first): still a success.
    expect(await verifyCustomerEmail(ctx, token)).toEqual({ customerId, alreadyVerified: true });
    await expectCode(verifyCustomerEmail(ctx, 'A'.repeat(43)), 'TOKEN_INVALID');
    await expectCode(verifyCustomerEmail(ctx, 'garbage'), 'TOKEN_INVALID');

    resolved = await resolveCustomerSession(ctx, session.token);
    expect(resolved?.emailVerified).toBe(true);
    expect(await sendEmailVerification(ctx, customerId, { locale: 'en' })).toEqual({
      alreadyVerified: true,
    });

    await revokeCustomerSession(ctx, session.token);
    expect(await resolveCustomerSession(ctx, session.token)).toBeNull();
    expect(await resolveCustomerSession(ctx, 'not a token')).toBeNull();
  });

  it('rejects weak passwords without creating anything', async () => {
    const email = 'weak@example.invalid';
    const err = await expectCode(
      registerCustomer(ctx, {
        firstName: 'W',
        lastName: 'K',
        email,
        password: 'short',
        locale: 'en',
      }),
      'WEAK_PASSWORD',
    );
    expect(err.details).toEqual({ min: 10 });
    expect(await handle.db.select().from(customers).where(eq(customers.email, email))).toHaveLength(
      0,
    );
  });

  it('answers neutrally for unknown and already registered addresses', async () => {
    const email = 'existing@example.invalid';
    const customerId = await verifiedAccount(email);
    const [before] = await handle.db.select().from(customers).where(eq(customers.id, customerId));

    // Registering again changes nothing and sends a login link instead.
    await registerCustomer(ctx, {
      firstName: 'Eve',
      lastName: 'Intruder',
      email,
      password: 'another password',
      locale: 'en',
    });
    const [after] = await handle.db.select().from(customers).where(eq(customers.id, customerId));
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.firstName).toBe('Test');
    expect((await lastMail(email)).key).toBe('CUSTOMER_LOGIN_LINK');

    // …or a password-reset link when login links are disabled.
    await setAccounts({ loginLinkEnabled: false });
    try {
      await registerCustomer(ctx, {
        firstName: 'Eve',
        lastName: 'Intruder',
        email,
        password: 'another password',
        locale: 'en',
      });
      const mail = await lastMail(email);
      expect(mail.key).toBe('CUSTOMER_PASSWORD_RESET');
      expect(mail.variables.resetUrl).toContain(`${APP_URL}/en/account/reset-password?token=`);
      await expectCode(requestLoginLink(ctx, { email, locale: 'en' }), 'LOGIN_LINK_DISABLED');
    } finally {
      await setAccounts({});
    }

    const unknown = 'nobody@example.invalid';
    await requestPasswordReset(ctx, { email: unknown, locale: 'en' });
    await requestLoginLink(ctx, { email: unknown, locale: 'en' });
    expect(await mailsTo(unknown)).toHaveLength(0);
    const a = await expectCode(
      authenticateCustomer(ctx, { email: unknown, password: PASSWORD }),
      'INVALID_CREDENTIALS',
    );
    const b = await expectCode(
      authenticateCustomer(ctx, { email, password: 'wrong password!' }),
      'INVALID_CREDENTIALS',
    );
    expect(a.message).toBe(b.message);
  });

  it('locks accounts – and unknown addresses alike – after repeated failures', async () => {
    const email = 'lockout@example.invalid';
    const customerId = await verifiedAccount(email);
    for (let i = 1; i <= 4; i += 1) {
      await expectCode(
        authenticateCustomer(ctx, { email, password: `wrong-${i}-password` }),
        'INVALID_CREDENTIALS',
      );
    }
    await expectCode(
      authenticateCustomer(ctx, { email, password: 'wrong-5-password' }),
      'ACCOUNT_LOCKED',
    );
    // Even the correct password is refused while locked.
    await expectCode(authenticateCustomer(ctx, { email, password: PASSWORD }), 'ACCOUNT_LOCKED');

    const unknown = 'lockout-unknown@example.invalid';
    for (let i = 1; i <= 4; i += 1) {
      await expectCode(
        authenticateCustomer(ctx, { email: unknown, password: `wrong-${i}-password` }),
        'INVALID_CREDENTIALS',
      );
    }
    await expectCode(
      authenticateCustomer(ctx, { email: unknown, password: 'wrong-5-password' }),
      'ACCOUNT_LOCKED',
    );
    await expectCode(
      authenticateCustomer(ctx, { email: unknown, password: PASSWORD }),
      'ACCOUNT_LOCKED',
    );

    // A login link proves ownership of the mailbox and lifts the lock.
    await requestLoginLink(ctx, { email, locale: 'en', returnPath: '/checkout' });
    const mail = await lastMail(email);
    expect(mail.key).toBe('CUSTOMER_LOGIN_LINK');
    expect(new URL(mail.variables.loginUrl!).searchParams.get('next')).toBe('/checkout');
    expect(await consumeLoginLink(ctx, tokenOf(mail.variables.loginUrl))).toEqual({
      customerId,
      passwordCleared: false,
    });
    expect(await authenticateCustomer(ctx, { email, password: PASSWORD })).toEqual({ customerId });
  });

  it('gives login links their own lifetime, independent of password reset links', async () => {
    const email = `ttl-${randomUUID().slice(0, 8)}@example.com`;
    const customerId = await verifiedAccount(email);
    await setAccounts({ passwordResetTtlMinutes: 120, loginLinkTtlMinutes: 10 });
    try {
      await requestLoginLink(ctx, { email, locale: 'en' });
      const [link] = await handle.db
        .select()
        .from(customerTokens)
        .where(eq(customerTokens.customerId, customerId))
        .orderBy(sql`created_at desc`)
        .limit(1);
      expect(link!.purpose).toBe('LOGIN_LINK');
      const minutes = (link!.expiresAt.getTime() - link!.createdAt.getTime()) / 60_000;
      expect(Math.round(minutes)).toBe(10);
    } finally {
      await setAccounts({});
    }
  });

  it('resets the password, revoking every session and the link itself', async () => {
    const email = 'reset@example.invalid';
    const customerId = await verifiedAccount(email);
    const s1 = await createCustomerSession(ctx, customerId);
    const s2 = await createCustomerSession(ctx, customerId);

    await requestPasswordReset(ctx, { email: 'RESET@example.invalid', locale: 'en' });
    const first = tokenOf((await lastMail(email)).variables.resetUrl);
    await requestPasswordReset(ctx, { email, locale: 'en' });
    const token = tokenOf((await lastMail(email)).variables.resetUrl);
    // Only the newest reset link stays valid.
    expect(await isPasswordResetTokenValid(ctx, first)).toBe(false);
    expect(await isPasswordResetTokenValid(ctx, token)).toBe(true);

    await expectCode(resetCustomerPassword(ctx, { token, password: 'short' }), 'WEAK_PASSWORD');
    expect(await isPasswordResetTokenValid(ctx, token)).toBe(true);

    const newPassword = 'a completely new secret';
    expect(await resetCustomerPassword(ctx, { token, password: newPassword })).toEqual({
      customerId,
    });
    expect(await resolveCustomerSession(ctx, s1.token)).toBeNull();
    expect(await resolveCustomerSession(ctx, s2.token)).toBeNull();
    expect(
      await handle.db
        .select()
        .from(customerSessions)
        .where(eq(customerSessions.customerId, customerId)),
    ).toHaveLength(0);
    expect(await isPasswordResetTokenValid(ctx, token)).toBe(false);
    await expectCode(
      resetCustomerPassword(ctx, { token, password: 'yet another password' }),
      'TOKEN_INVALID',
    );
    await expectCode(
      authenticateCustomer(ctx, { email, password: PASSWORD }),
      'INVALID_CREDENTIALS',
    );
    expect(await authenticateCustomer(ctx, { email, password: newPassword })).toEqual({
      customerId,
    });
  });

  it('upgrades a guest and shows its orders only after verification', async () => {
    const email = 'guest@example.invalid';
    const [guest] = await handle.db
      .insert(customers)
      .values({ email, firstName: 'Gus', lastName: 'Guest', locale: 'en' })
      .returning();

    // One paid order with a standing ticket for an event.
    const [venue] = await handle.db
      .insert(venues)
      .values({ name: 'Hall', slug: `hall-${uuid().slice(0, 6)}`, timeZone: 'Europe/Berlin' })
      .returning();
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const [section] = await handle.db
      .insert(seatMapSections)
      .values({
        seatMapId: map!.id,
        type: 'STANDING',
        name: 'Floor',
        ticketLabel: 'Floor',
        capacity: 100,
        geometry: { type: 'rect', x: 0, y: 0, width: 50, height: 50, rotation: 0 },
      })
      .returning();
    const [tax] = await handle.db
      .insert(taxRates)
      .values({ name: `t-${uuid()}`, rateBasisPoints: 700 })
      .returning();
    const startsAt = new Date(Date.now() + 20 * 86_400_000);
    const [event] = await handle.db
      .insert(events)
      .values({
        venueId: venue!.id,
        seatMapId: map!.id,
        slug: `gala-${uuid().slice(0, 6)}`,
        title: 'Gala',
        subtitle: 'Opening night',
        startsAt,
        timeZone: 'Europe/Berlin',
        currency: 'EUR',
        taxRateId: tax!.id,
      })
      .returning();
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId: event!.id, name: 'Cat 1', color: '#112233', basePrice: 2000 })
      .returning();
    const [tariff] = await handle.db
      .insert(ticketTypes)
      .values({ eventId: event!.id, name: 'Normal' })
      .returning();
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `T-${uuid().slice(0, 8)}`,
        customerId: guest!.id,
        status: 'PAID',
        channel: 'ONLINE',
        paymentMethod: 'PAYPAL',
        email,
        firstName: 'Gus',
        lastName: 'Guest',
        locale: 'en',
        currency: 'EUR',
        subtotalGross: 4000,
        totalGross: 4000,
        totalNet: 3738,
        totalTax: 262,
        amountPaid: 4000,
        paidAt: new Date(),
      })
      .returning();
    const item = {
      orderId: order!.id,
      eventId: event!.id,
      kind: 'GENERAL_ADMISSION' as const,
      sectionId: section!.id,
      priceCategoryId: category!.id,
      ticketTypeId: tariff!.id,
      status: 'CONFIRMED' as const,
      sectionLabel: 'Floor',
      categoryName: 'Cat 1',
      ticketTypeName: 'Normal',
      unitPriceGross: 2000,
      priceGross: 2000,
      taxRateBasisPoints: 700,
      priceNet: 1869,
      taxAmount: 131,
    };
    await handle.db.insert(orderItems).values([item, item]);

    // Guests cannot sign in or request links.
    await expectCode(
      authenticateCustomer(ctx, { email, password: PASSWORD }),
      'INVALID_CREDENTIALS',
    );
    await requestLoginLink(ctx, { email, locale: 'en' });
    expect(await mailsTo(email)).toHaveLength(0);

    await registerCustomer(ctx, {
      firstName: 'Gustav',
      lastName: 'Guest',
      email,
      password: PASSWORD,
      locale: 'de',
    });
    const [upgraded] = await handle.db.select().from(customers).where(eq(customers.email, email));
    expect(upgraded!.id).toBe(guest!.id);
    expect(upgraded!.firstName).toBe('Gustav');
    expect(upgraded!.locale).toBe('en');
    expect(upgraded!.passwordHash).not.toBeNull();

    const { customerId } = await authenticateCustomer(ctx, { email, password: PASSWORD });
    expect(await listCustomerOrders(ctx, customerId)).toEqual([]);

    // Resend creates a second valid link; the first one still works.
    const firstLink = (await lastMail(email)).variables.verificationUrl;
    expect(
      await sendEmailVerification(ctx, customerId, { locale: 'de', returnPath: '/orders' }),
    ).toEqual({
      alreadyVerified: false,
    });
    const resent = await lastMail(email);
    expect(resent.locale).toBe('de');
    expect(new URL(resent.variables.verificationUrl!).searchParams.get('next')).toBe('/orders');
    await verifyCustomerEmail(ctx, tokenOf(firstLink));

    const list = await listCustomerOrders(ctx, customerId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: order!.id,
      orderNumber: order!.orderNumber,
      status: 'PAID',
      paymentMethod: 'PAYPAL',
      totalGross: 4000,
      currency: 'EUR',
      ticketCount: 2,
      events: [
        { eventId: event!.id, title: 'Gala', subtitle: 'Opening night', timeZone: 'Europe/Berlin' },
      ],
    });
    expect(list[0]!.events[0]!.startsAt.getTime()).toBe(startsAt.getTime());
  });

  it('discards a provisional password when a login link first proves the address', async () => {
    const email = 'prehijack@example.invalid';
    // Someone registers with an address they do not own …
    await registerCustomer(ctx, {
      firstName: 'Mal',
      lastName: 'Lory',
      email,
      password: PASSWORD,
      locale: 'en',
    });
    const { customerId } = await authenticateCustomer(ctx, { email, password: PASSWORD });
    const intruder = await createCustomerSession(ctx, customerId);

    // … the real owner signs in via login link.
    await requestLoginLink(ctx, { email, locale: 'en' });
    const token = tokenOf((await lastMail(email)).variables.loginUrl);
    expect(await consumeLoginLink(ctx, token)).toEqual({ customerId, passwordCleared: true });
    await expectCode(consumeLoginLink(ctx, token), 'TOKEN_INVALID');

    expect(await resolveCustomerSession(ctx, intruder.token)).toBeNull();
    await expectCode(
      authenticateCustomer(ctx, { email, password: PASSWORD }),
      'INVALID_CREDENTIALS',
    );

    const owner = await createCustomerSession(ctx, customerId);
    expect(await resolveCustomerSession(ctx, owner.token)).toMatchObject({
      emailVerified: true,
      hasPassword: false,
    });
    // Setting a password needs no current one now.
    await changeCustomerPassword(
      ctx,
      customerId,
      { newPassword: 'owner chosen password' },
      { keepSessionToken: owner.token },
    );
    expect(await authenticateCustomer(ctx, { email, password: 'owner chosen password' })).toEqual({
      customerId,
    });
    expect((await resolveCustomerSession(ctx, owner.token))?.hasPassword).toBe(true);
  });

  it('changes password and profile, keeping only the current session', async () => {
    const email = 'profile@example.invalid';
    const customerId = await verifiedAccount(email);
    const current = await createCustomerSession(ctx, customerId);
    const other = await createCustomerSession(ctx, customerId);

    await expectCode(
      changeCustomerPassword(ctx, customerId, {
        currentPassword: 'not the password',
        newPassword: 'brand new password',
      }),
      'CURRENT_PASSWORD_INVALID',
    );
    await expectCode(
      changeCustomerPassword(ctx, customerId, { currentPassword: PASSWORD, newPassword: 'short' }),
      'WEAK_PASSWORD',
    );
    await changeCustomerPassword(
      ctx,
      customerId,
      { currentPassword: PASSWORD, newPassword: 'brand new password' },
      { keepSessionToken: current.token },
    );
    expect(await resolveCustomerSession(ctx, current.token)).not.toBeNull();
    expect(await resolveCustomerSession(ctx, other.token)).toBeNull();

    await updateCustomerProfile(ctx, customerId, {
      firstName: ' Grace ',
      lastName: 'Hopper',
      phone: '+49 30 1234567',
      address: {
        street: 'Example Street 1',
        postalCode: '12345',
        city: 'Example City',
        country: 'DE',
      },
    });
    expect(await resolveCustomerSession(ctx, current.token)).toMatchObject({
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+49 30 1234567',
      email,
      address: {
        street: 'Example Street 1',
        postalCode: '12345',
        city: 'Example City',
        country: 'DE',
      },
    });
    await updateCustomerProfile(ctx, customerId, {
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '',
      address: null,
    });
    expect(await resolveCustomerSession(ctx, current.token)).toMatchObject({
      phone: null,
      address: null,
    });
    await expect(
      updateCustomerProfile(ctx, customerId, {
        firstName: 'Grace',
        lastName: 'Hopper',
        address: { street: 'X', postalCode: '1', city: 'Y', country: 'Germany' },
      }),
    ).rejects.toThrow();
  });

  it('refuses everything while accounts are disabled', async () => {
    const email = 'disabled@example.invalid';
    const customerId = await verifiedAccount(email);
    const session = await createCustomerSession(ctx, customerId);
    await setAccounts({ enabled: false });
    try {
      expect(await resolveCustomerSession(ctx, session.token)).toBeNull();
      await expectCode(
        authenticateCustomer(ctx, { email, password: PASSWORD }),
        'ACCOUNTS_DISABLED',
      );
      await expectCode(
        registerCustomer(ctx, {
          firstName: 'A',
          lastName: 'B',
          email: 'new-disabled@example.invalid',
          password: PASSWORD,
          locale: 'en',
        }),
        'ACCOUNTS_DISABLED',
      );
      await expectCode(requestPasswordReset(ctx, { email, locale: 'en' }), 'ACCOUNTS_DISABLED');
      await expectCode(createCustomerSession(ctx, customerId), 'ACCOUNTS_DISABLED');
      await expectCode(listCustomerOrders(ctx, customerId), 'ACCOUNTS_DISABLED');
    } finally {
      await setAccounts({});
    }
    expect(await resolveCustomerSession(ctx, session.token)).not.toBeNull();
  });
});
