import { parseArgs } from 'node:util';
import { ADMIN_ROLES, type AdminRole } from '@tix/shared';
import { generateToken, hashPassword } from '@tix/shared/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { adminUsers } from '../schema';

/**
 * Bootstrap / recovery CLI for Admin Portal accounts.
 *
 *   pnpm admin:create --email admin@example.org --name "Jane Doe" [--role SUPER_ADMIN] [--reset]
 *
 * The password is taken from ADMIN_PASSWORD or generated and printed exactly once.
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
    role: z.array(z.enum(ADMIN_ROLES)).min(1).default(['SUPER_ADMIN']),
    reset: z.boolean(),
  })
  .parse(values);

const envPassword = process.env.ADMIN_PASSWORD;
if (envPassword !== undefined && envPassword.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters long');
  process.exit(1);
}
const password = envPassword ?? generateToken(18);

const handle = createDb({
  connectionString: requireEnv('DATABASE_URL'),
  poolMax: 1,
  applicationName: 'tix-cli',
});

async function main(): Promise<void> {
  const passwordHash = await hashPassword(password);
  const roles: AdminRole[] = input.role;
  const [existing] = await handle.db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(sql`lower(${adminUsers.email}) = ${input.email}`);

  if (existing && !input.reset) {
    throw new Error(`Admin ${input.email} already exists – use --reset to set a new password`);
  }

  if (existing) {
    await handle.db
      .update(adminUsers)
      .set({
        passwordHash,
        roles,
        displayName: input.name,
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
      })
      .where(sql`${adminUsers.id} = ${existing.id}`);
    console.log(`Password reset for ${input.email} (roles: ${roles.join(', ')})`);
  } else {
    await handle.db.insert(adminUsers).values({
      email: input.email,
      displayName: input.name,
      passwordHash,
      roles,
      passwordChangedAt: new Date(),
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
