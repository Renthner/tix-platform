import {
  auditLogs,
  customerSessions,
  customerTokens,
  customers,
  emailMessages,
  events,
  orderItems,
  orders,
  withTransaction,
  type Executor,
} from '@tix/db';
import {
  INVENTORY_HOLDING_ITEM_STATUSES,
  SUPPORTED_LOCALES,
  postalAddressSchema,
  type OrderStatus,
} from '@tix/shared';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { AdminActor } from '../admin-users';
import { DomainError, type CoreContext } from '../context';
import { createEmailMessage, CUSTOMER_EMAIL_OBSOLETE_ERROR, dispatchEmailMessage } from '../email';
import { coreLog } from '../log';
import { applyOrderEmailChange } from '../orders/email-change';
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
  createdAt: Date;
  orderCount: number;
  /** Paid minus refunded, grouped per currency is overkill here: orders share the shop currency. */
  revenue: number;
  lastOrderAt: Date | null;
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const CUSTOMER_SORT_KEYS = ['name', 'created', 'orders', 'lastOrder'] as const;
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];

export async function listCustomers(
  ctx: Pick<CoreContext, 'db'>,
  options: {
    q?: string;
    page?: number;
    pageSize?: number;
    /** Default: last order, newest first. */
    sort?: CustomerSortKey;
    dir?: 'asc' | 'desc';
  } = {},
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
    // Test orders (super-admin purchases on draft events) are no customer history.
    .where(eq(orders.isTest, false))
    .groupBy(orders.customerId)
    .as('stats');

  const dir = options.dir === 'asc' ? 'asc' : 'desc';
  const direction = dir === 'asc' ? asc : desc;
  const orderBy = (() => {
    switch (options.sort) {
      case 'name':
        return [
          direction(sql`lower(${customers.lastName})`),
          direction(sql`lower(${customers.firstName})`),
        ];
      case 'created':
        return [direction(customers.createdAt)];
      case 'orders':
        return [direction(sql`coalesce(${stats.orderCount}, 0)`), desc(customers.createdAt)];
      default:
        return [
          sql`${stats.lastOrderAt} ${sql.raw(dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST`,
          desc(customers.createdAt),
        ];
    }
  })();

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
        createdAt: customers.createdAt,
        orderCount: sql<number>`coalesce(${stats.orderCount}, 0)::int`,
        revenue: sql<number>`coalesce(${stats.revenue}, 0)::int`,
        lastOrderAt: sql<Date | null>`${stats.lastOrderAt}`.mapWith((v) =>
          v === null || v === undefined ? null : new Date(v as string),
        ),
      })
      .from(customers)
      .leftJoin(stats, eq(stats.customerId, customers.id))
      .where(where)
      .orderBy(...orderBy, asc(customers.id))
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
  isTest: boolean;
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
      isTest: orders.isTest,
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
    // Test orders are no customer history (same rule as the list).
    revenue: orderRows
      .filter((o) => !o.isTest)
      .reduce((sum, o) => sum + o.amountPaid - o.amountRefunded, 0),
  };
}

// ─── Profile ──────────────────────────────────────────────────────────────────────────

/** Orders in these states are never moved along with a customer e-mail change. */
const NOT_MOVED_ORDER_STATUSES = [
  // A PayPal approval may be in progress: the return URL carries the order token, a version
  // bump would break the capture on return. Such orders are short-lived (expire / get paid).
  'PENDING',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
] as const satisfies readonly OrderStatus[];

export interface UpdateCustomerOptions {
  /**
   * Only relevant when the e-mail changes: also move the customer's current orders to the new
   * address (see `updateCustomerAsAdmin`). Default false (the orders keep their buyer snapshot).
   */
  moveOrders?: boolean;
}

/**
 * Edits the customer record. Past orders keep their buyer snapshot. Changing the e-mail
 * address of an account un-verifies it and ends all sessions (the new owner must prove the
 * address; login links keep working for the new address).
 *
 * With `moveOrders` and a changed e-mail, the customer's CURRENT orders move to the new address in
 * the same transaction, with the semantics of `changeOrderEmail` (token version bump = earlier
 * order links die, history + audit, mails still queued for the old address retired and the
 * important ones re-created for the new one). Moved are orders that
 *  - belong to this customer record AND still carry the customer's previous address (orders left
 *    on an even older address by an earlier per-order change stay as they are),
 *  - are not PENDING / CANCELLED / EXPIRED / REFUNDED, not test orders, not anonymised,
 *  - have at least one inventory-holding item of an event that has not ended yet
 *    (`coalesce(ends_at, starts_at) > now()`, like the GDPR erasure blockers).
 * The order stays with the same customer record, so per-customer ticket limits are unaffected.
 * Instead of two mails per order, ONE summary (`CUSTOMER_EMAIL_CHANGED_ORDERS`, the moved orders
 * with their fresh links, built at send time) goes to the new address and ONE notice
 * (`CUSTOMER_EMAIL_CHANGED_OLD`, order numbers only – no links, no new address) to the old one;
 * no mails when nothing was moved.
 * Also excluded: orders with an open additional payment whose PayPal attempt is in flight (the
 * PayPal return URL carries the order token).
 * Lock order: customer row, then per eligible order (by id) the payment-mail advisory lock, then
 * the order rows (FOR UPDATE, by id) – advisory lock before the row like `processPaidOrder`.
 * A summary of an earlier change still queued/failed for the previous address is retired.
 */
export async function updateCustomerAsAdmin(
  ctx: CoreContext,
  actor: AdminActor,
  customerId: string,
  input: AdminCustomerProfileInput,
  options: UpdateCustomerOptions = {},
): Promise<{ movedOrders: number }> {
  const data = adminCustomerProfileSchema.parse(input);
  const outcome = await withTransaction(ctx.db, async (tx) => {
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
    if (changed.length === 0) return { moved: 0, messages: [] as string[] };
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

    const messages: string[] = [];
    const moved: { id: string; orderNumber: string; locale: string }[] = [];
    if (emailChanged) {
      // A summary of an earlier change still waiting for the previous address must not go out:
      // it names that address and lists order links (the delivery checks this as well).
      await tx
        .update(emailMessages)
        .set({ status: 'FAILED', lastError: CUSTOMER_EMAIL_OBSOLETE_ERROR, updatedAt: new Date() })
        .where(
          and(
            eq(emailMessages.templateKey, 'CUSTOMER_EMAIL_CHANGED_ORDERS'),
            inArray(emailMessages.status, ['QUEUED', 'FAILED']),
            sql`${emailMessages.attachments}->>'customerId' = ${customerId}`,
            sql`lower(trim(${emailMessages.toEmail})) = ${current.email.trim().toLowerCase()}`,
          ),
        );
    }
    if (emailChanged && options.moveOrders) {
      const previous = current.email.trim().toLowerCase();
      const eligibleWhere = and(
        eq(orders.customerId, customerId),
        sql`lower(trim(${orders.email})) = ${previous}`,
        notInArray(orders.status, [...NOT_MOVED_ORDER_STATUSES]),
        eq(orders.isTest, false),
        isNull(orders.anonymizedAt),
        exists(
          tx
            .select({ one: sql`1` })
            .from(orderItems)
            .innerJoin(events, eq(events.id, orderItems.eventId))
            .where(
              and(
                eq(orderItems.orderId, orders.id),
                inArray(orderItems.status, [...INVENTORY_HOLDING_ITEM_STATUSES]),
                sql`coalesce(${events.endsAt}, ${events.startsAt}) > now()`,
              ),
            ),
        ),
        // An open additional payment with a PayPal attempt in flight: its return URL carries the
        // order token, which the move would invalidate (same condition as the dunning sweep).
        sql`not exists (select 1 from order_adjustments a join payments p on p.adjustment_id = a.id where a.order_id = ${orders.id} and a.status in ('PROPOSED','CONFIRMED') and p.method = 'PAYPAL' and p.status in ('CREATED','APPROVED'))`,
      );
      // Lock order like the payment confirmation (`processPaidOrder`: advisory lock, then the
      // order row): first the payment-mail advisory locks in id order, then the rows. The
      // condition is evaluated again under the row locks.
      const candidates = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eligibleWhere)
        .orderBy(asc(orders.id));
      for (const { id } of candidates) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`order-paid-mail:${id}`}))`);
      }
      const eligible =
        candidates.length === 0
          ? []
          : await tx
              .select()
              .from(orders)
              .where(
                and(
                  inArray(
                    orders.id,
                    candidates.map((c) => c.id),
                  ),
                  eligibleWhere,
                ),
              )
              .orderBy(asc(orders.id))
              .for('update', { of: orders });
      for (const order of eligible) {
        const result = await applyOrderEmailChange(ctx, tx, order, {
          newEmail: data.email,
          customerId,
          userId: actor.userId,
          limitsOverridden: false,
          changeMails: false,
          via: 'customer',
        });
        messages.push(...result.messages);
        moved.push({ id: order.id, orderNumber: order.orderNumber, locale: order.locale });
      }
      if (moved.length > 0) {
        const locale = data.locale ?? moved[0]!.locale;
        // New address: the moved orders with their links (built at send time from the ids).
        messages.unshift(
          await createEmailMessage(ctx, tx, {
            key: 'CUSTOMER_EMAIL_CHANGED_ORDERS',
            to: data.email,
            customerId,
            locale,
            // Recipient data as of this change (never read from the customer row at send time:
            // a later correction of the address must not show up in this mail).
            variables: {
              email: data.email,
              firstName: data.firstName,
              lastName: data.lastName,
              fullName: `${data.firstName} ${data.lastName}`.trim(),
              previousEmail: current.email,
              movedOrderIds: moved.map((o) => o.id).join(','),
              movedOrderCount: moved.length,
            },
          }),
          // Old address: notice only – order numbers, never links or the new address (GDPR).
          // `customerId` only lets an erasure find the message; the renderer does not read the
          // customer for this key.
          await createEmailMessage(ctx, tx, {
            key: 'CUSTOMER_EMAIL_CHANGED_OLD',
            to: current.email,
            customerId,
            locale,
            variables: {
              firstName: data.firstName,
              previousEmail: current.email,
              movedOrderCount: moved.length,
              movedOrderNumbers: moved.map((o) => o.orderNumber).join(', '),
            },
          }),
        );
      }
    }
    await writeCustomerAudit(tx, actor, 'customer.update', customerId, {
      fields: changed,
      ...(emailChanged && options.moveOrders ? { movedOrders: moved.length } : {}),
    });
    return { moved: moved.length, messages };
  }).catch((err: unknown) => {
    // Drizzle wraps driver errors: the unique index race surfaces with the code on `cause`.
    if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new DomainError('EMAIL_TAKEN', 'This e-mail address belongs to another customer', 409);
    }
    throw err;
  });
  for (const id of outcome.messages) {
    await dispatchEmailMessage(ctx, id).catch((err: unknown) =>
      coreLog.error({ err }, '[customer-email] mail stored but not queued (outbox retries)'),
    );
  }
  return { movedOrders: outcome.moved };
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
