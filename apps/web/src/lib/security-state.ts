import type { TotpSetup } from '@tix/core';

/**
 * Result of the account / user-management / password-link actions. Errors are machine-readable
 * codes translated in the UI (`adminSecurity.errors.<code>`).
 */
export const SECURITY_ERROR_CODES = [
  'GENERIC',
  'VALIDATION',
  'MISMATCH',
  'WRONG_PASSWORD',
  'INVALID_CODE',
  'WEAK_PASSWORD',
  'PASSWORD_TOO_LONG',
  'TWO_FACTOR_REQUIRED',
  'TWO_FACTOR_ALREADY_ENABLED',
  'TWO_FACTOR_NO_SETUP',
  'ACCOUNT_LOCKED',
  'RATE_LIMITED',
  'TOKEN_INVALID',
  'EMAIL_TAKEN',
  'LAST_SUPER_ADMIN',
  'CANNOT_DEACTIVATE_SELF',
  'INVITE_NOT_PENDING',
  'USER_HAS_SIGNED_IN',
  'ADMIN_USER_NOT_FOUND',
] as const;
export type SecurityErrorCode = (typeof SECURITY_ERROR_CODES)[number];

export type SecurityState =
  | { status: 'idle' }
  | {
      status: 'success';
      at: number;
      /** Which message to show (`adminSecurity.messages.<key>`). */
      message?: string;
      recoveryCodes?: string[];
      setup?: TotpSetup;
    }
  | { status: 'error'; code: SecurityErrorCode; min?: number; at: number };

export const SECURITY_IDLE: SecurityState = { status: 'idle' };
