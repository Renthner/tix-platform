import { DISCOUNT_CODE_PATTERN, normalizeDiscountCode } from '@tix/shared';
import { DomainError, type CoreContext } from '../context';
import { previewCartDiscounts, type CartDiscountPreview } from '../orders/pricing';
import {
  MAX_CODES_PER_CART,
  discountRejectionError,
  getSessionDiscountCodes,
  setSessionDiscountCodes,
} from './plan';

/**
 * Enter / remove a discount code in the cart. The code is validated against the cart as it is
 * now (availability, scope, minimum value, usage, stacking) and only stored when it applies;
 * the binding check happens again, atomically, when the order is placed.
 */
export async function applyDiscountCodeToCart(
  ctx: CoreContext,
  sessionId: string,
  rawCode: string,
  options: { locale?: string; email?: string | null } = {},
): Promise<CartDiscountPreview> {
  const code = normalizeDiscountCode(rawCode);
  if (!DISCOUNT_CODE_PATTERN.test(code)) {
    throw discountRejectionError({ code, reason: 'INVALID' });
  }
  const current = await getSessionDiscountCodes(ctx, sessionId);
  if (current.includes(code)) {
    return previewCartDiscounts(ctx, sessionId, options.locale, { email: options.email });
  }
  if (current.length >= MAX_CODES_PER_CART) {
    throw new DomainError('DISCOUNT_TOO_MANY_CODES', 'Too many discount codes', 422);
  }
  const next = [...current, code];
  const preview = await previewCartDiscounts(ctx, sessionId, options.locale, {
    email: options.email,
    codes: next,
  });
  const rejected = preview.rejected.find((r) => r.code === code);
  // Codes that were already in the cart and turned invalid are reported by the cart itself.
  if (rejected) throw discountRejectionError(rejected);
  // Not rejected but not applied either: there is nothing in the cart to discount.
  if (!preview.applied.some((a) => a.code === code)) {
    throw new DomainError('CART_EMPTY', 'Your cart is empty', 409);
  }
  await setSessionDiscountCodes(ctx, sessionId, next);
  return preview;
}

export async function removeDiscountCodeFromCart(
  ctx: CoreContext,
  sessionId: string,
  rawCode: string,
): Promise<void> {
  const code = normalizeDiscountCode(rawCode);
  const current = await getSessionDiscountCodes(ctx, sessionId);
  await setSessionDiscountCodes(
    ctx,
    sessionId,
    current.filter((c) => c !== code),
  );
}
