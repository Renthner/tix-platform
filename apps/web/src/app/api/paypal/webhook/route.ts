import { requestLogger } from '@/server/logger';
import { DomainError, handlePayPalWebhook } from '@tix/core';
import { NextResponse } from 'next/server';
import { getCore } from '@/server/core';
import { readMaintenance } from '@/server/maintenance-gate';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * POST – PayPal webhook endpoint. Configure `<shop URL>/api/paypal/webhook` in the PayPal
 * developer dashboard and enter its webhook id in the admin. Non-2xx answers make PayPal
 * retry the delivery.
 */
export async function POST(request: Request) {
  // Restore running: answer 503 so PayPal redelivers the webhook later (nothing is lost).
  if ((await readMaintenance()).active) {
    return NextResponse.json(
      { error: 'MAINTENANCE' },
      { status: 503, headers: { 'retry-after': '60' } },
    );
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
  }
  try {
    const outcome = await handlePayPalWebhook(getCore(), request.headers, raw);
    if (outcome === 'INVALID_SIGNATURE') {
      return NextResponse.json({ status: outcome }, { status: 400 });
    }
    return NextResponse.json({ status: outcome });
  } catch (err) {
    if (err instanceof DomainError && err.status < 500) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    requestLogger(request).error({ err }, '[paypal] webhook processing failed');
    return NextResponse.json({ error: 'PROCESSING_FAILED' }, { status: 500 });
  }
}
