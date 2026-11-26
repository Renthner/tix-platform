import { Badge } from '@/components/ui/badge';

export type UserStatus = 'locked' | 'inactive' | 'invited' | 'active';

/** Display status of an admin user (precedence: locked, deactivated, invited, active). */
export function userStatus(
  user: { isActive: boolean; invitePending: boolean; lockedUntil: Date | null },
  now: Date,
): UserStatus {
  if (user.isActive && user.lockedUntil && user.lockedUntil > now) return 'locked';
  if (!user.isActive) return 'inactive';
  if (user.invitePending) return 'invited';
  return 'active';
}

const VARIANT = {
  locked: 'destructive',
  inactive: 'secondary',
  invited: 'outline',
  active: 'default',
} as const;

/** Status badge of an admin user (server-friendly; the label comes translated). */
export function UserStatusBadge({ status, label }: { status: UserStatus; label: string }) {
  return <Badge variant={VARIANT[status]}>{label}</Badge>;
}
