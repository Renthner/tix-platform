import 'server-only';
import type { AdminRole } from '@tix/shared';

/** SUPER_ADMIN implicitly holds every role. Managing devices, pairing codes, assignments. */
export const SCANNER_MANAGE_ROLES: AdminRole[] = ['EVENT_MANAGER'];
/** Read-only: device list, statistics, scan log, app download. */
export const SCANNER_VIEW_ROLES: AdminRole[] = ['EVENT_MANAGER', 'DOOR_STAFF'];
/** Uploading and publishing APK releases. */
export const SCANNER_APK_ROLES: AdminRole[] = ['SUPER_ADMIN'];
