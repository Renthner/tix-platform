import { ApiError } from './api';

/** One zod issue as returned by the APIs (`VALIDATION_FAILED` → `details.issues`). */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Maps a zod issue path (e.g. `buyer.address.street`) to the id of the form control. `fields`
 * lists path prefixes; the longest matching prefix wins (`address.street` before `address`).
 */
export type FieldMap = Record<string, string>;

export function validationIssues(err: unknown): ValidationIssue[] | null {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_FAILED') return null;
  const raw = err.details?.issues;
  if (!Array.isArray(raw)) return null;
  const issues = raw.filter(
    (i): i is ValidationIssue =>
      typeof i === 'object' &&
      i !== null &&
      typeof (i as ValidationIssue).path === 'string' &&
      typeof (i as ValidationIssue).message === 'string',
  );
  return issues.length > 0 ? issues : null;
}

export function fieldForPath(path: string, fields: FieldMap): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const [prefix, id] of Object.entries(fields)) {
    const matches = path === prefix || path.startsWith(`${prefix}.`);
    if (matches && prefix.length > bestLength) {
      best = id;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Zod issues → `{ controlId: first message }` for the paths the form knows. */
export function mapIssuesToFields(
  issues: readonly ValidationIssue[],
  fields: FieldMap,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const id = fieldForPath(issue.path, fields);
    if (id && !(id in out)) out[id] = issue.message;
  }
  return out;
}
