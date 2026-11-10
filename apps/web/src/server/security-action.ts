import 'server-only';
import { DomainError } from '@tix/core';
import {
  SECURITY_ERROR_CODES,
  type SecurityErrorCode,
  type SecurityState,
} from '@/lib/security-state';

export const ok = (
  extra: Omit<Extract<SecurityState, { status: 'success' }>, 'status' | 'at'> = {},
): SecurityState => ({
  status: 'success',
  at: Date.now(),
  ...extra,
});

export const fail = (code: SecurityErrorCode, min?: number): SecurityState => ({
  status: 'error',
  code,
  ...(min === undefined ? {} : { min }),
  at: Date.now(),
});

/** Runs a domain operation and maps its DomainErrors to a form state (other errors propagate). */
export async function guarded(fn: () => Promise<SecurityState>): Promise<SecurityState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) {
      const code = (SECURITY_ERROR_CODES as readonly string[]).includes(err.code)
        ? (err.code as SecurityErrorCode)
        : 'GENERIC';
      const min = typeof err.details?.min === 'number' ? err.details.min : undefined;
      return fail(code, min);
    }
    throw err;
  }
}
