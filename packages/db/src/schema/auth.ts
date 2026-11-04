import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, timestamps, tstz } from './_columns';
import { actorTypeEnum, adminRoleEnum } from './enums';
import { scannerDevices } from './checkin';

/** Back-office users (Admin Portal). Customers never log in – they are identified per order. */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: id(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** Argon2id PHC string. NULL while an invitation has not been accepted. */
    passwordHash: text('password_hash'),
    roles: adminRoleEnum('roles').array().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** TOTP secret, AES-256-GCM encrypted (secret-box envelope). */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: tstz('locked_until'),
    lastLoginAt: tstz('last_login_at'),
    passwordChangedAt: tstz('password_changed_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('admin_users_email_uq').on(sql`lower(${t.email})`),
    check('admin_users_roles_not_empty', sql`cardinality(${t.roles}) > 0`),
    check('admin_users_failed_login_count_nonneg', sql`${t.failedLoginCount} >= 0`),
  ],
);

/** Server-side admin sessions. Only the SHA-256 of the session token is stored. */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    expiresAt: tstz('expires_at').notNull(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    mfaVerifiedAt: tstz('mfa_verified_at'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('admin_sessions_user_idx').on(t.userId),
    index('admin_sessions_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Append-only audit trail (GoBD traceability) for every administrative mutation:
 * settings changes, refunds, manual payment assignments, seat blocks, check-in overrides …
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    actorDeviceId: uuid('actor_device_id').references((): AnyPgColumn => scannerDevices.id, {
      onDelete: 'set null',
    }),
    /** Dotted action name, e.g. `order.refund`, `settings.update`, `seat.block`. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** `{ before, after }` of changed fields; secrets are redacted before writing. */
    changes: jsonb('changes'),
    metadata: jsonb('metadata'),
    ipAddress: inet('ip_address'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.createdAt),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);
