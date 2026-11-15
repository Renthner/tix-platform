import {
  applyDiscountCodeToCart,
  previewCartDiscounts,
  removeDiscountCodeFromCart,
} from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCore } from '@/server/core';
import { getCustomerSession } from '@/server/customer-session';
import { clientIp, enforceRateLimit, handle, parseBody } from '@/server/http';
import { readSessionId } from '@/server/session';

export const dynamic = 'force-dynamic';

const body = z.object({ code: z.string().min(1).max(64) });
const headers = { 'cache-control': 'no-store' };

/** GET – discount codes of the cart and what they take off (rejected ones are reported). */
export async function GET(request: Request) {
  return handle(async () => {
    const sid = await readSessionId();
    const empty = { codes: [], applied: [], rejected: [], total: 0, currency: 'EUR' };
    if (!sid) return NextResponse.json(empty, { headers });
    const locale = new URL(request.url).searchParams.get('locale') ?? undefined;
    const customer = await getCustomerSession();
    const preview = await previewCartDiscounts(getCore(), sid, locale, {
      email: customer?.email ?? null,
    });
    return NextResponse.json(preview, { headers });
  });
}

/** POST – enters a discount code (validated against the cart; stored only when it applies). */
export async function POST(request: Request) {
  return handle(async () => {
    const sid = await readSessionId();
    if (!sid)
      return NextResponse.json(
        { error: { code: 'CART_EMPTY', message: 'Your cart is empty' } },
        { status: 409 },
      );
    // Guessing codes: tight per-session budget plus a per-IP one (a new session is free).
    await enforceRateLimit('discount-code', sid, 20, 60_000);
    await enforceRateLimit('discount-code-ip', await clientIp(), 60, 10 * 60_000);
    const { code } = await parseBody(request, body);
    const customer = await getCustomerSession();
    const preview = await applyDiscountCodeToCart(getCore(), sid, code, {
      email: customer?.email ?? null,
    });
    return NextResponse.json(preview, { headers });
  });
}

/** DELETE – removes a discount code from the cart. */
export async function DELETE(request: Request) {
  return handle(async () => {
    const sid = await readSessionId();
    if (sid) {
      const { code } = await parseBody(request, body);
      await removeDiscountCodeFromCart(getCore(), sid, code);
    }
    return new NextResponse(null, { status: 204, headers });
  });
}
