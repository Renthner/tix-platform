import { parseArgs } from 'node:util';
import { ADMIN_ROLES, parseSetting, type AdminRole } from '@tix/shared';
import { generateToken, hashPassword } from '@tix/shared/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import {
  adminRecoveryCodes,
  adminSessions,
  adminTokens,
  adminUsers,
  auditLogs,
  customerSessions,
  systemSettings,
} from '../schema';

/**
 * Bootstrap / recovery CLI for Admin Portal accounts.
 *
 *   pnpm admin:create --email admin@example.org --name "Jane Doe" [--role SUPER_ADMIN] [--reset]
 *
 * The password is taken from ADMIN_PASSWORD or generated and printed exactly once and must meet
 * the configured minimum length (security settings, default 12).
 *
 * `--reset` on an existing user keeps the roles unless `--role` is given, and ends everything the
 * old credentials could still use: sessions (incl. linked customer sessions), invitation / reset links and recovery codes (a lost
 * authenticator is cleared as well). The reset is audited as `admin_user.cli_reset`.
 */

loadRootEnv();

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', multiple: true },
    reset: { type: 'boolean', default: false },
  },
  strict: true,
});

const input = z
  .object({
    email: z.email().transform((e) => e.trim().toLowerCase()),
    name: z.string().trim().min(2).max(120),
    role: z.array(z.enum(ADMIN_ROLES)).min(1).optional(),
    reset: z.boolean(),
  })
  .parse(values);

const envPassword = process.env.ADMIN_PASSWORD;
const password = envPassword ?? generateToken(18);

const handle = createDb({
  connectionString: requireEnv('DATABASE_URL'),
  poolMax: 1,
  applicationName: 'tix-cli',
});

async function main(): Promise<void> {
  const [stored] = await handle.db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, 'security'));
  const { minPasswordLength } = parseSetting('security', stored?.value ?? {});
  if ([...password].length < minPasswordLength) {
    throw new Error(`ADMIN_PASSWORD must be at least ${minPasswordLength} characters long`);
  }
  const passwordHash = await hashPassword(password);
  const [existing] = await handle.db
    .select({ id: adminUsers.id, roles: adminUsers.roles })
    .from(adminUsers)
    .where(sql`lower(${adminUsers.email}) = ${input.email}`);

  if (existing && !input.reset) {
    throw new Error(`Admin ${input.email} already exists – use --reset to set a new password`);
  }

  if (existing) {
    const roles: AdminRole[] = input.role ?? existing.roles;
    await handle.db.transaction(async (tx) => {
      await tx
        .update(adminUsers)
        .set({
          passwordHash,
          roles,
          displayName: input.name,
          isActive: true,
          failedLoginCount: 0,
          lockedUntil: null,
          // Recovery path: a lost authenticator is cleared as well (set it up again after signing in).
          totpSecretEncrypted: null,
          totpPendingSecretEncrypted: null,
          totpLastStep: null,
          passwordChangedAt: new Date(),
        })
        .where(eq(adminUsers.id, existing.id));
      await tx.delete(adminSessions).where(eq(adminSessions.userId, existing.id));
      // Customer sessions created by linking this admin end with its sessions.
      await tx.delete(customerSessions).where(eq(customerSessions.linkedAdminUserId, existing.id));
      await tx.delete(adminTokens).where(eq(adminTokens.userId, existing.id));
      await tx.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.userId, existing.id));
      await tx.insert(auditLogs).values({
        actorType: 'SYSTEM',
        actorUserId: null,
        action: 'admin_user.cli_reset',
        entityType: 'admin_user',
        entityId: existing.id,
        changes: { roles },
      });
    });
    console.log(`Password reset for ${input.email} (roles: ${roles.join(', ')})`);
  } else {
    const roles: AdminRole[] = input.role ?? ['SUPER_ADMIN'];
    await handle.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(adminUsers)
        .values({
          email: input.email,
          displayName: input.name,
          passwordHash,
          roles,
          passwordChangedAt: new Date(),
        })
        .returning({ id: adminUsers.id });
      await tx.insert(auditLogs).values({
        actorType: 'SYSTEM',
        actorUserId: null,
        action: 'admin_user.cli_create',
        entityType: 'admin_user',
        entityId: user!.id,
        changes: { roles },
      });
    });
    console.log(`Admin ${input.email} created (roles: ${roles.join(', ')})`);
  }
  if (envPassword === undefined) {
    console.log(`Generated password (shown once): ${password}`);
  }
}

main()
  .then(() => handle.close())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await handle.close();
    process.exit(1);
  });
