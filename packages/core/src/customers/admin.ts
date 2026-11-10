import {
  auditLogs,
  customerSessions,
  customerTokens,
  customers,
  orders,
  withTransaction,
  type Executor,
} from '@tix/db';
import { SUPPORTED_LOCALES, postalAddressSchema, type OrderStatus } from '@tix/shared';
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdminActor } from '../admin-users';
import { DomainError, type CoreContext } from '../context';
import { customerEmailSchema } from './accounts';

/**
 * Admin customer management (profile edits, account housekeeping, lists). The GDPR export and
 * erasure live in `privacy.ts`. Audit entries never contain personal data values – only the
 * names of the changed fields – so the append-only trail does not undo an erasure.
 */

const PAGE_SIZE_MAX = 200;

const notFound = () => new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
const anonymized = () =>
  new DomainError('CUSTOMER_ANONYMIZED', 'The customer has been anonymised', 409);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const adminCustomerProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: customerEmailSchema,
  company: optionalText(200),
  phone: optionalText(50),
  address: postalAddressSchema.nullable(),
  locale: z.enum(SUPPORTED_LOCALES).nullable(),
});
export type AdminCustomerProfileInput = z.input<typeof adminCustomerProfileSchema>;

export async function writeCustomerAudit(
  db: Executor,
  actor: AdminActor,
  action: string,
  customerId: string,
  changes?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLogs).values({
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    action,
    entityType: 'customer',
    entityId: customerId,
    changes: changes ?? null,
  });
}

// ─── List ─────────────────────────────────────────────────────────────────────────────

export interface CustomerListRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  hasAccount: boolean;
  emailVerified: boolean;
  anonymizedAt: Date | null;
  orderCount: number;
  /** Paid minus refunded, grouped per currency is overkill here: orders share the shop currency. */
  revenue: number;
  lastOrderAt: Date | null;
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listCustomers(
  ctx: Pick<CoreContext, 'db'>,
  options: { q?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: CustomerListRow[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 50), 1), PAGE_SIZE_MAX);
  const page = Math.max(Math.trunc(options.page ?? 1), 1);
  const q = options.q?.trim().slice(0, 100);
  const where = q
    ? or(
        ilike(sql`${customers.firstName} || ' ' || ${customers.lastName}`, likePattern(q)),
        ilike(sql`${customers.lastName} || ' ' || ${customers.firstName}`, likePattern(q)),
        ilike(customers.email, likePattern(q)),
        ilike(customers.phone, likePattern(q)),
        ilike(customers.company, likePattern(q)),
      )
    : undefined;

  const stats = ctx.db
    .select({
      customerId: orders.customerId,
      orderCount: sql<number>`count(*)::int`.as('order_count'),
      revenue:
        sql<number>`coalesce(sum(${orders.amountPaid} - ${orders.amountRefunded}), 0)::int`.as(
          'revenue',
        ),
      lastOrderAt: sql<Date | null>`max(${orders.createdAt})`.as('last_order_at'),
    })
    .from(orders)
    .groupBy(orders.customerId)
    .as('stats');

  const [rows, [total]] = await Promise.all([
    ctx.db
      .select({
        id: customers.id,
        firstName: customers.firstName,
        lastName: customers.lastName,
        email: customers.email,
        phone: customers.phone,
        hasAccount: sql<boolean>`${customers.accountCreatedAt} IS NOT NULL`,
        emailVerified: sql<boolean>`${customers.emailVerifiedAt} IS NOT NULL`,
        anonymizedAt: customers.anonymizedAt,
        orderCount: sql<number>`coalesce(${stats.orderCount}, 0)::int`,
        revenue: sql<number>`coalesce(${stats.revenue}, 0)::int`,
        lastOrderAt: sql<Date | null>`${stats.lastOrderAt}`.mapWith((v) =>
          v === null || v === undefined ? null : new Date(v as string),
        ),
      })
      .from(customers)
      .leftJoin(stats, eq(stats.customerId, customers.id))
      .where(where)
      .orderBy(
        sql`${stats.lastOrderAt} DESC NULLS LAST`,
        desc(customers.createdAt),
        asc(customers.id),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}

// ─── Detail ───────────────────────────────────────────────────────────────────────────

export interface CustomerAdminOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: Date;
  totalGross: number;
  amountPaid: number;
  amountRefunded: number;
  currency: string;
  anonymizedAt: Date | null;
  personalDataRetainedUntil: Date | null;
}

export async function getCustomerAdminView(ctx: Pick<CoreContext, 'db'>, customerId: string) {
  const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return null;
  const orderRows: CustomerAdminOrder[] = await ctx.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      createdAt: orders.createdAt,
      totalGross: orders.totalGross,
      amountPaid: orders.amountPaid,
      amountRefunded: orders.amountRefunded,
      currency: orders.currency,
      anonymizedAt: orders.anonymizedAt,
      personalDataRetainedUntil: orders.personalDataRetainedUntil,
    })
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.createdAt), desc(orders.id));
  const { passwordHash, ...profile } = customer;
  return {
    customer: {
      ...profile,
      hasAccount: customer.accountCreatedAt !== null,
      hasPassword: passwordHash !== null,
      locked: customer.lockedUntil !== null && customer.lockedUntil > new Date(),
    },
    orders: orderRows,
    revenue: orderRows.reduce((sum, o) => sum + o.amountPaid - o.amountRefunded, 0),
  };
}

// ─── Profile ──────────────────────────────────────────────────────────────────────────

/**
 * Edits the customer record. Past orders keep their buyer snapshot. Changing the e-mail
 * address of an account un-verifies it and ends all sessions (the new owner must prove the
 * address; login links keep working for the new address).
 */
export async function updateCustomerAsAdmin(
  ctx: CoreContext,
  actor: AdminActor,
  customerId: string,
  input: AdminCustomerProfileInput,
): Promise<void> {
  const data = adminCustomerProfileSchema.parse(input);
  await withTransaction(ctx.db, async (tx) => {
    const [current] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .for('update');
    if (!current) throw notFound();
    if (current.anonymizedAt) throw anonymized();
    const emailChanged = current.email.toLowerCase() !== data.email;
    if (emailChanged) {
      const [taken] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(sql`lower(${customers.email}) = ${data.email}`);
      if (taken && taken.id !== customerId) {
        throw new DomainError(
          'EMAIL_TAKEN',
          'This e-mail address belongs to another customer',
          409,
        );
      }
    }
    const next = {
      firstName: data.firstName,
      lastName: data.lastName,
      email: emailChanged ? data.email : current.email,
      company: data.company,
      phone: data.phone,
      address: data.address,
      locale: data.locale,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      (key) => JSON.stringify(next[key] ?? null) !== JSON.stringify(current[key] ?? null),
    );
    if (changed.length === 0) return;
    await tx
      .update(customers)
      .set({
        ...next,
        ...(emailChanged && current.accountCreatedAt ? { emailVerifiedAt: null } : {}),
      })
      .where(eq(customers.id, customerId));
    if (emailChanged) {
      await tx.delete(customerSessions).where(eq(customerSessions.customerId, customerId));
      await tx.delete(customerTokens).where(eq(customerTokens.customerId, customerId));
    }
    await writeCustomerAudit(tx, actor, 'customer.update', customerId, { fields: changed });
  }).catch((err: unknown) => {
    // Drizzle wraps driver errors: the unique index race surfaces with the code on `cause`.
    if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new DomainError('EMAIL_TAKEN', 'This e-mail address belongs to another customer', 409);
    }
    throw err;
  });
}

// ─── Account housekeeping ─────────────────────────────────────────────────────────────

/** Lifts a lockout caused by failed sign-ins. */
export async function unlockCustomerAccount(
  ctx: CoreContext,
  actor: AdminActor,
  customerId: string,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const [row] = await tx
      .update(customers)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(and(eq(customers.id, customerId), isNull(customers.anonymizedAt)))
      .returning({ id: customers.id });
    if (!row) throw notFound();
    await writeCustomerAudit(tx, actor, 'customer.unlock', customerId);
  });
}

/**
 * Removes the customer's sign-in: password, verification, sessions and outstanding links go;
 * the customer record and its orders stay (the person becomes a guest again).
 */
export async function removeCustomerLogin(
  ctx: CoreContext,
  actor: AdminActor,
  customerId: string,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const [row] = await tx
      .update(customers)
      .set({
        passwordHash: null,
        accountCreatedAt: null,
        emailVerifiedAt: null,
        lastLoginAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(and(eq(customers.id, customerId), isNull(customers.anonymizedAt)))
      .returning({ id: customers.id });
    if (!row) throw notFound();
    await tx.delete(customerSessions).where(eq(customerSessions.customerId, customerId));
    await tx.delete(customerTokens).where(eq(customerTokens.customerId, customerId));
    await writeCustomerAudit(tx, actor, 'customer.remove_login', customerId);
  });
}
