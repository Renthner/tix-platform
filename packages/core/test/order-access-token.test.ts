/**
 * Order access tokens: tokens without a version claim (issued before `orders.token_version`)
 * must keep verifying as version 0; versioned tokens carry their version.
 */
import { signToken } from '@tix/shared/server';
import { describe, expect, it } from 'vitest';
import { orderAccessToken, parseOrderAccessToken } from '../src';

const ctx = { sessionSecret: 'x'.repeat(48) };
const orderId = '5f1c0f0e-4a2b-4c3d-8e9f-0a1b2c3d4e5f';

describe('order access token compatibility', () => {
  it('a legacy token (no version claim) parses as version 0', () => {
    const legacy = signToken('order', { oid: orderId }, 3600, ctx.sessionSecret);
    expect(parseOrderAccessToken(ctx, legacy)).toEqual({ orderId, version: 0 });
  });

  it('version 0 is issued without a claim, identical in shape to legacy tokens', () => {
    expect(parseOrderAccessToken(ctx, orderAccessToken(ctx, orderId))).toEqual({
      orderId,
      version: 0,
    });
    expect(parseOrderAccessToken(ctx, orderAccessToken(ctx, orderId, 0))?.version).toBe(0);
  });

  it('embeds a non-zero version', () => {
    expect(parseOrderAccessToken(ctx, orderAccessToken(ctx, orderId, 3))).toEqual({
      orderId,
      version: 3,
    });
  });

  it('rejects malformed version claims, wrong secrets, wrong types and garbage', () => {
    for (const v of ['1', -1, 1.5, null]) {
      const t = signToken('order', { oid: orderId, v }, 3600, ctx.sessionSecret);
      expect(parseOrderAccessToken(ctx, t)).toBeNull();
    }
    const other = { sessionSecret: 'y'.repeat(48) };
    expect(parseOrderAccessToken(other, orderAccessToken(ctx, orderId))).toBeNull();
    expect(
      parseOrderAccessToken(ctx, signToken('holder', { oid: orderId }, 3600, ctx.sessionSecret)),
    ).toBeNull();
    expect(parseOrderAccessToken(ctx, 'nope')).toBeNull();
    expect(parseOrderAccessToken(ctx, null)).toBeNull();
  });
});
