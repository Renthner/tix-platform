import { joinWaitlist } from '@tix/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { clientIp, enforceRateLimit, handle, parseBody } from '@/server/http';
import { ensureSessionId } from '@/server/session';
import { loadShopEvent } from '@/server/shop';

export const dynamic = 'force-dynamic';

const body = z.object({
  email: z.string().max(254),
  firstName: z.string().max(100).optional(),
  quantity: z.number().int().min(1).max(50),
  categoryId: z.uuid().nullable().optional(),
  locale: z.string().max(10).optional(),
  /** Honeypot: real visitors never fill this hidden field. */
  website: z.string().max(200).optional(),
});

/**
 * Joins the waiting list (double opt-in e-mail follows). Abuse protection without a captcha:
 * per-IP and per-session limits, a per-address limit (nobody can flood a mailbox) and a honeypot.
 */
export async function POST(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  return handle(async () => {
    const { core, event } = await loadShopEvent((await params).eventId);
    const sid = await ensureSessionId();
    await enforceRateLimit('waitlist-ip', await clientIp(), 10, 60 * 60_000);
    await enforceRateLimit('waitlist-session', sid, 5, 60 * 60_000);
    const input = await parseBody(request, body);
    // Bots filling the hidden field get the normal answer and nothing happens.
    if (input.website) return NextResponse.json({ status: 'CONFIRMATION_SENT' });
    await enforceRateLimit(
      'waitlist-email',
      `${event.id}:${input.email.trim().toLowerCase()}`,
      3,
      24 * 60 * 60_000,
    );
    const { website: _website, ...rest } = input;
    const result = await joinWaitlist(core, event, rest);
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  });
}
