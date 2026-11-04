/** PostgreSQL SQLSTATE codes the application reacts to. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  EXCLUSION_VIOLATION: '23P01',
  RESTRICT_VIOLATION: '23001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
} as const;

interface PgErrorLike {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/**
 * Drizzle wraps driver errors (`DrizzleQueryError` → `cause`). Walk the cause chain and
 * return the underlying `pg` DatabaseError, if any.
 */
export function findPgError(err: unknown): PgErrorLike | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      typeof current.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return current as PgErrorLike;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function pgErrorCode(err: unknown): string | undefined {
  return findPgError(err)?.code;
}

function isViolation(code: string, err: unknown, constraint?: string): boolean {
  const pgErr = findPgError(err);
  if (!pgErr || pgErr.code !== code) return false;
  return constraint === undefined || pgErr.constraint === constraint;
}

export const isUniqueViolation = (err: unknown, constraint?: string) =>
  isViolation(PG_ERROR.UNIQUE_VIOLATION, err, constraint);

export const isCheckViolation = (err: unknown, constraint?: string) =>
  isViolation(PG_ERROR.CHECK_VIOLATION, err, constraint);

export const isForeignKeyViolation = (err: unknown, constraint?: string) =>
  isViolation(PG_ERROR.FOREIGN_KEY_VIOLATION, err, constraint);

/**
 * Deleting a row that is still referenced through an `ON DELETE RESTRICT` foreign key
 * (e.g. a seat that appears in an order) or hitting an immutability trigger (invoices).
 */
export const isRestrictViolation = (err: unknown, constraint?: string) =>
  isViolation(PG_ERROR.RESTRICT_VIOLATION, err, constraint);

/** Errors that are safe to retry by re-running the whole transaction. */
export function isTransientTransactionError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === PG_ERROR.SERIALIZATION_FAILURE || code === PG_ERROR.DEADLOCK_DETECTED;
}
