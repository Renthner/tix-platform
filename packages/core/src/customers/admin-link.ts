import { normalizeLocale } from '@tix/shared';
import {
  adminUsers,
  customerSessions,
  customerTokens,
  customers,
  withTransaction,
  type Executor,
} from '@tix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  checkAdminPassword,
  writeAdminAudit,
  registerAdminPasswordFailure,
  type AdminPasswordCheck,
} from '../admin-users';
import { DomainError, type CoreContext } from '../context';
import { getSetting } from '../settings';
import {
  checkCustomerPassword,
  countCustomerLoginFailure,
  customerAccountsEnabled,
  customerEmailSchema,
} from './accounts';

/**
 * One sign-in form for the shop, two separate account tables.
 *
 * `checkSharedLogin` tells which account(s) an e-mail + password belongs to without opening
 * a session (the caller does that: admin accounts go through the two-factor path first).
 * `linkCustomerForAdmin` gives a signed-in admin the matching customer row ("one account feel").
 */

const MAX_PASSWORD_LENGTH = 1_024;

type AdminPasswordOk = Extract<AdminPasswordCheck, { status: 'ok' }>;

export type SharedLoginResult =
  /** The admin password matched (the customer account of that address is linked after sign-in). */
  | { kind: 'admin'; admin: AdminPasswordOk }
  /** Only the customer password matched; `passwordHash` is the verified hash (see `SessionOptions`). */
  | { kind: 'customer'; customerId: string; passwordHash: string }
  /** Nothing matched: INVALID_CREDENTIALS or ACCOUNT_LOCKED (identical for known / unknown addresses). */
  | { kind: 'invalid'; error: DomainError };

const invalid = (): SharedLoginResult => ({
  kind: 'invalid',
  error: new DomainError('INVALID_CREDENTIALS', 'E-mail address or password is not correct', 401),
});

/**
 * Checks e-mail + password against the admin account and the customer account of the address.
 *
 * - Admin password matches → `admin` (even if the customer password matches too: the admin
 *   path is the stricter one and links the customer account afterwards).
 * - Else customer password matches → `customer`. An admin lockout never blocks this.
 * - A right password of a LOCKED account is not a failure: nothing is charged to either account.
 * - Else a failure is counted: against the admin account (lockout) and the customer account /
 *   per-address counter – only now, so signing in with the other account's password does not
 *   lock anybody. Both accounts answer with the customer-side error sequence, so locked or
 *   unknown admin accounts are indistinguishable.
 * No session is created here.
 */
export async function checkSharedLogin(
  ctx: CoreContext,
  input: { email: string; password: string },
  ipAddress?: string | null,
): Promise<SharedLoginResult> {
  const email = customerEmailSchema.safeParse(input.email);
  if (!email.success) return invalid();
  const password = input.password;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return invalid();

  const adminCheck = await checkAdminPassword(ctx, email.data, password, ipAddress, {
    deferFailure: true,
  });
  if (adminCheck.status === 'ok') return { kind: 'admin', admin: adminCheck };

  const customer = await checkCustomerPassword(ctx, { email: email.data, password });
  if (customer.status === 'ok') {
    return {
      kind: 'customer',
      customerId: customer.customerId,
      passwordHash: customer.passwordHash,
    };
  }
  // Right password, locked account: no cross-charge (the locked customer row answers
  // ACCOUNT_LOCKED without counting; a locked admin account just fails).
  if (adminCheck.passwordMatched) return invalid();
  if (customer.status === 'locked-match') {
    return { kind: 'invalid', error: await countCustomerLoginFailure(ctx, email.data) };
  }

  if (adminCheck.failedUserId) {
    await registerAdminPasswordFailure(ctx, adminCheck.failedUserId, ipAddress);
  }
  return { kind: 'invalid', error: await countCustomerLoginFailure(ctx, email.data) };
}

// ─── Linking an admin to a customer row ───────────────────────────────────────────────

/** "Erika Mustermann" → first/last name; a single word keeps "-" as last name (column is required). */
export function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const [first = '', ...rest] = displayName.trim().split(/\s+/);
  return {
    firstName: (first || displayName.trim() || '-').slice(0, 100),
    lastName: rest.join(' ').slice(0, 100) || '-',
  };
}

/** Admin and customer session belong together when they carry the same e-mail address. */
export function isLinkedPair(adminEmail: string, customerEmail: string): boolean {
  return adminEmail.trim().toLowerCase() === customerEmail.trim().toLowerCase();
}

/**
 * Discards everything an earlier registrant of this (still unverified) address could use: the
 * password, all sessions and every unused e-mail token.
 */
async function discardProvisionalAccess(tx: Executor, customerId: string): Promise<void> {
  await tx.delete(customerSessions).where(eq(customerSessions.customerId, customerId));
  await tx
    .delete(customerTokens)
    .where(and(eq(customerTokens.customerId, customerId), isNull(customerTokens.consumedAt)));
}

/**
 * The customer row for a signed-in admin (same e-mail), created or activated on demand, ready
 * for a customer session. Call ONLY after a complete admin sign-in (password + second factor).
 *
 * SECURITY: the row may have been registered by somebody else with the admin's address. While
 * it is unverified, its password hash, sessions and tokens are removed BEFORE the address is
 * marked verified, so a pre-registration attacker cannot get into the admin's account. A
 * verified row keeps its password and sessions (its owner proved the mailbox).
 * Returns null when customer accounts are off, the admin is gone/inactive or the customer was
 * anonymised.
 */
export async function linkCustomerForAdmin(
  ctx: CoreContext,
  adminUserId: string,
): Promise<{ customerId: string; created: boolean; provisionalDiscarded: boolean } | null> {
  if (!(await customerAccountsEnabled(ctx))) return null;
  const [admin] = await ctx.db
    .select({
      email: adminUsers.email,
      displayName: adminUsers.displayName,
      isActive: adminUsers.isActive,
      emailVerifiedAt: adminUsers.emailVerifiedAt,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId));
  // Only a proven mailbox may take over the customer account of that address.
  if (!admin?.isActive || !admin.emailVerifiedAt) return null;
  const email = customerEmailSchema.safeParse(admin.email);
  if (!email.success) return null;
  const locale = normalizeLocale((await getSetting(ctx, 'general')).defaultLocale);
  const name = splitDisplayName(admin.displayName);

  return withTransaction(ctx.db, async (tx) => {
    const select = () =>
      tx
        .select({
          id: customers.id,
          passwordHash: customers.passwordHash,
          emailVerifiedAt: customers.emailVerifiedAt,
          anonymizedAt: customers.anonymizedAt,
        })
        .from(customers)
        .where(sql`lower(${customers.email}) = ${email.data}`)
        .for('update');

    let [row] = await select();
    let created = false;
    if (!row) {
      const inserted = await tx
        .insert(customers)
        .values({
          email: email.data,
          ...name,
          locale,
          accountCreatedAt: new Date(),
          emailVerifiedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: customers.id });
      created = inserted.length > 0;
      // A concurrent checkout / registration may have created the row meanwhile.
      [row] = await select();
      if (!row) throw new Error('Customer row vanished while linking an admin');
    }
    if (row.anonymizedAt) return null;

    const provisional = row.emailVerifiedAt === null;
    const provisionalDiscarded = provisional && row.passwordHash !== null;
    if (provisional) await discardProvisionalAccess(tx, row.id);
    await tx
      .update(customers)
      .set({
        accountCreatedAt: sql`coalesce(${customers.accountCreatedAt}, now())`,
        emailVerifiedAt: sql`coalesce(${customers.emailVerifiedAt}, now())`,
        ...(provisional ? { passwordHash: null, failedLoginCount: 0, lockedUntil: null } : {}),
      })
      .where(eq(customers.id, row.id));
    await writeAdminAudit(tx, { userId: adminUserId }, 'admin_user.customer_link', adminUserId, {
      customerId: row.id,
      created,
      provisionalDiscarded,
    });
    return { customerId: row.id, created, provisionalDiscarded };
  });
}
