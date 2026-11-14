import { cartHasDraftEvents } from '@tix/core';
import { getCore } from '@/server/core';
import { readSessionId } from '@/server/session';
import { getShopActor } from '@/server/shop-actor';
import { DraftBanner } from './draft-banner';

/** Banner for cart and checkout while the cart holds seats of a draft event (super-admins only). */
export async function DraftCartNotice() {
  if (!(await getShopActor())) return null;
  const sid = await readSessionId();
  if (!sid || !(await cartHasDraftEvents(getCore(), sid))) return null;
  return <DraftBanner />;
}
