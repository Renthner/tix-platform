import 'server-only';
import {
  createCustomerSession,
  resolveCustomerSession,
  revokeCustomerSession,
  type CustomerSessionRecord,
} from '@tix/core';
import type { PostalAddress } from '@tix/shared';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { getCore } from './core';
import { clientIp } from './http';
import { cookieDefaults } from './session';

/** Session cookie of an optional customer account (random token; only its hash is stored). */
export const CUSTOMER_COOKIE = 'tix_customer';

export interface CustomerSession {
  customerId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  address: PostalAddress | null;
  /** Orders are only shown to the customer once the e-mail address is verified. */
  emailVerified: boolean;
}

/** Raw session cookie value (route handlers / server actions use it to keep the session). */
export async function readCustomerSessionToken(): Promise<string | null> {
  const token = (await cookies()).get(CUSTOMER_COOKIE)?.value;
  return token && token.length <= 200 ? token : null;
}

/**
 * Full session record (incl. `hasPassword`, `locale`) for the account pages – memoised per
 * request. Null when signed out, expired, revoked, anonymised or accounts are disabled.
 */
export const getCustomerSessionRecord = cache(async (): Promise<CustomerSessionRecord | null> => {
  const token = await readCustomerSessionToken();
  return token ? resolveCustomerSession(getCore(), token) : null;
});

/** Signed-in customer of the current request (memoised per request), else null. */
export const getCustomerSession = cache(async (): Promise<CustomerSession | null> => {
  const record = await getCustomerSessionRecord();
  if (!record) return null;
  return {
    customerId: record.customerId,
    email: record.email,
    firstName: record.firstName,
    lastName: record.lastName,
    phone: record.phone,
    address: record.address,
    emailVerified: record.emailVerified,
  };
});

/**
 * Opens a session and sets the cookie (route handlers / server actions only). A session the
 * browser already carried is ended first (no session fixation, no orphaned rows).
 */
export async function signInCustomer(customerId: string): Promise<void> {
  const jar = await cookies();
  const previous = jar.get(CUSTOMER_COOKIE)?.value;
  const core = getCore();
  if (previous) await revokeCustomerSession(core, previous);
  const ip = await clientIp();
  const userAgent = (await headers()).get('user-agent');
  const session = await createCustomerSession(core, customerId, { ipAddress: ip, userAgent });
  jar.set(CUSTOMER_COOKIE, session.token, cookieDefaults(session.maxAgeSeconds));
}

/** Ends the current session and removes the cookie (route handlers / server actions only). */
export async function signOutCustomer(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(CUSTOMER_COOKIE)?.value;
  if (token) await revokeCustomerSession(getCore(), token);
  jar.delete(CUSTOMER_COOKIE);
}
