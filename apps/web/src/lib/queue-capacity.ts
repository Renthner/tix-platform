/**
 * Server-wide waiting-room cap (`queueCapacity.maxActiveShoppers`): shown in the global
 * waiting-room form and saved only for super-admins. Event managers keep editing the other
 * global waiting-room defaults; a post of theirs that carries the field is ignored.
 */
export function canEditServerCapacity(roles: readonly string[]): boolean {
  return roles.includes('SUPER_ADMIN');
}

/** Whether a waiting-room form post updates the server-wide cap. */
export function shouldSaveServerCapacity(args: {
  /** null = global form. */
  eventId: string | null;
  /** The post contains the `maxActiveShoppers` field (`FormData.has`). */
  hasField: boolean;
  roles: readonly string[];
}): boolean {
  return args.eventId === null && args.hasField && canEditServerCapacity(args.roles);
}
