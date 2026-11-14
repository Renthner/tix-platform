import 'server-only';
import { resolveShopActor, type ShopActor } from '@tix/core';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { getAdminSession } from './auth';

/** Staff cookie: the super-admin wants to experience the waiting room like a customer. */
export const QUEUE_TEST_COOKIE = 'tix_admin_queue_test';

/**
 * Shop privileges of the current request: only a signed-in SUPER_ADMIN (role read from the
 * database on every request, two-factor set-up complete – the same bar as the admin API) gets an
 * actor. Never derived from anything the client could forge; other roles (EVENT_MANAGER, …) get
 * nothing. Memoised per request.
 */
export const getShopActor = cache(async (): Promise<ShopActor | null> => {
  const jar = await cookies();
  // Cheap exit for the overwhelming majority of visitors (no admin session cookie at all).
  if (!jar.get('tix_admin')?.value) return null;
  return resolveShopActor(await getAdminSession(), jar.get(QUEUE_TEST_COOKIE)?.value === '1');
});
