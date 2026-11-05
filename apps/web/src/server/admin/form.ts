import 'server-only';
import { z } from 'zod';
import {
  FIELD_ERROR_CODES,
  type ActionState,
  type FieldErrorCode,
  type FormErrorCode,
} from '@/lib/action-state';

/** Reads a trimmed string; empty strings become undefined (so optional fields stay optional). */
export function text(fd: FormData, name: string): string | undefined {
  const v = fd.get(name);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Switch / checkbox value ("on" when checked). */
export function flag(fd: FormData, name: string): boolean {
  const v = fd.get(name);
  return v === 'on' || v === 'true' || v === '1';
}

/** Tri-state select: "inherit" → null, "on"/"off" → boolean. */
export function triState(fd: FormData, name: string): boolean | null {
  const v = fd.get(name);
  if (v === 'on') return true;
  if (v === 'off') return false;
  return null;
}

/** Maps Zod issues to translatable field error codes. */
export function zodFieldErrors(error: z.ZodError): Partial<Record<string, FieldErrorCode>> {
  const out: Partial<Record<string, FieldErrorCode>> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (out[key]) continue;
    if ((FIELD_ERROR_CODES as readonly string[]).includes(issue.message)) {
      out[key] = issue.message as FieldErrorCode;
    } else if (issue.code === 'too_small') {
      out[key] = issue.origin === 'string' && issue.minimum === 1 ? 'required' : 'tooSmall';
    } else if (issue.code === 'too_big') {
      out[key] = issue.origin === 'string' ? 'tooLong' : 'tooLarge';
    } else if (issue.code === 'invalid_type' && issue.input === undefined) {
      out[key] = 'required';
    } else {
      out[key] = 'invalid';
    }
  }
  return out;
}

export const fieldError = (fieldErrors: Partial<Record<string, FieldErrorCode>>): ActionState => ({
  status: 'error',
  fieldErrors,
  at: Date.now(),
});

export const formError = (code: FormErrorCode): ActionState => ({
  status: 'error',
  formError: code,
  at: Date.now(),
});

export const success = (
  message: Extract<ActionState, { status: 'success' }>['message'] = 'saved',
): ActionState => ({
  status: 'success',
  message,
  at: Date.now(),
});
