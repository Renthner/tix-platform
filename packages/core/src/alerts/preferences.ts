import { adminUsers, withTransaction } from '@tix/db';
import {
  alertPreferencesSchema,
  effectiveAlertTypes,
  selectableAlertTypes,
  type AdminAlertType,
} from '@tix/shared';
import { eq } from 'drizzle-orm';
import { writeAdminAudit, type AdminActor } from '../admin-users';
import { DomainError, type CoreContext } from '../context';

export interface OwnAlertPreferences {
  /** Types the roles of the user allow (the rest is not offered at all). */
  selectable: AdminAlertType[];
  /** Types the user receives right now. */
  selected: AdminAlertType[];
  /** The user never chose: the role defaults apply. */
  isDefault: boolean;
}

export async function getOwnAlertPreferences(
  ctx: Pick<CoreContext, 'db'>,
  userId: string,
): Promise<OwnAlertPreferences> {
  const [user] = await ctx.db
    .select({ roles: adminUsers.roles, prefs: adminUsers.alertPreferences })
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1);
  if (!user) throw new DomainError('ADMIN_USER_NOT_FOUND', 'Admin user not found', 404);
  return {
    selectable: selectableAlertTypes(user.roles),
    selected: effectiveAlertTypes(user.roles, user.prefs),
    isDefault: !alertPreferencesSchema.safeParse(user.prefs).success,
  };
}

/** Saves the alert types the signed-in admin wants; types outside the roles are rejected. */
export async function saveOwnAlertPreferences(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
  types: readonly string[],
): Promise<void> {
  const parsed = alertPreferencesSchema.parse({ types: [...new Set(types)] });
  await withTransaction(ctx.db, async (tx) => {
    const [user] = await tx
      .select({ roles: adminUsers.roles })
      .from(adminUsers)
      .where(eq(adminUsers.id, actor.userId))
      .for('update');
    if (!user) throw new DomainError('ADMIN_USER_NOT_FOUND', 'Admin user not found', 404);
    const allowed = new Set(selectableAlertTypes(user.roles));
    if (parsed.types.some((t) => !allowed.has(t))) {
      throw new DomainError(
        'ALERT_TYPE_NOT_ALLOWED',
        'This alert is not available for your role',
        403,
      );
    }
    await tx
      .update(adminUsers)
      .set({ alertPreferences: parsed })
      .where(eq(adminUsers.id, actor.userId));
    await writeAdminAudit(tx, actor, 'admin_user.alert_preferences', actor.userId, {
      types: parsed.types,
    });
  });
}

/** Back to the defaults of the roles. */
export async function resetOwnAlertPreferences(
  ctx: CoreContext,
  actor: AdminActor & { userId: string },
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await tx
      .update(adminUsers)
      .set({ alertPreferences: null })
      .where(eq(adminUsers.id, actor.userId));
    await writeAdminAudit(tx, actor, 'admin_user.alert_preferences', actor.userId, {
      types: 'DEFAULT',
    });
  });
}
