import { DomainError, PayPalCredentialsError } from '@tix/core';

/**
 * Rejected PayPal credentials are a configuration problem (already logged once by core): the
 * buyer gets a distinct "PayPal not available" error instead of an unhandled 500.
 */
export function rethrowPayPalCredentials(err: unknown): never {
  if (err instanceof PayPalCredentialsError) {
    throw new DomainError('PAYPAL_UNAVAILABLE', 'PayPal payment is currently not available', 503);
  }
  throw err;
}
