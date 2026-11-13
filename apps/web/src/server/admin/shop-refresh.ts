import 'server-only';
import { invalidateShopCache } from '@tix/core';
import { revalidatePath } from 'next/cache';
import { getCore } from '@/server/core';

/**
 * Call after an admin change committed that affects cached shop data: evicts the shop data cache
 * tags on EVERY web instance (Redis pub/sub, see docs/ARCHITECTURE.md "Shop data cache") and
 * refreshes the Next.js route cache. Never call it inside the transaction that made the change.
 */
export async function refreshShop(tags: readonly string[] | 'all'): Promise<void> {
  await invalidateShopCache(getCore(), tags);
  revalidatePath('/', 'layout');
}
