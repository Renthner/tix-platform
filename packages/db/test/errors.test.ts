import { describe, expect, it } from 'vitest';
import { isDbBusyError } from '../src/errors';

const pgError = (code: string, message = 'boom') => Object.assign(new Error(message), { code });
/** Drizzle wraps driver errors: DrizzleQueryError.cause = pg DatabaseError. */
const wrapped = (cause: unknown) => new Error('Failed query', { cause });

describe('isDbBusyError', () => {
  it('maps lock timeouts, serialization failures and deadlocks', () => {
    expect(isDbBusyError(wrapped(pgError('55P03')))).toBe(true);
    expect(isDbBusyError(wrapped(pgError('40001')))).toBe(true);
    expect(isDbBusyError(wrapped(pgError('40P01')))).toBe(true);
  });

  it('maps only statement / lock timeouts of 57014, not user cancellations', () => {
    expect(
      isDbBusyError(wrapped(pgError('57014', 'canceling statement due to statement timeout'))),
    ).toBe(true);
    expect(
      isDbBusyError(wrapped(pgError('57014', 'canceling statement due to user request'))),
    ).toBe(false);
  });

  it('maps pool connect timeouts', () => {
    expect(isDbBusyError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(
      isDbBusyError(wrapped(new Error('Connection terminated due to connection timeout'))),
    ).toBe(true);
  });

  it('does not map other errors', () => {
    expect(isDbBusyError(wrapped(pgError('23505')))).toBe(false);
    expect(isDbBusyError(new Error('something else'))).toBe(false);
    expect(isDbBusyError(undefined)).toBe(false);
  });
});
