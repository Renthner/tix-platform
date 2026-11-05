import { discardCart, getCart } from '@tix/core';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { handle } from '@/server/http';
import { readSessionId } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET – the multi-event cart of this browser session. */
export async function GET() {
  return handle(async () => {
    const sid = await readSessionId();
    const cart = sid
      ? await getCart(getCore(), sid)
      : { expiresAt: null, events: [], itemCount: 0, totalGross: 0, currencies: [] };
    return NextResponse.json(cart, { headers: { 'cache-control': 'no-store' } });
  });
}

/** DELETE – empties the cart and releases all seats / standing spots. */
export async function DELETE() {
  return handle(async () => {
    const sid = await readSessionId();
    if (sid) await discardCart(getCore(), sid);
    return new NextResponse(null, { status: 204 });
  });
}
