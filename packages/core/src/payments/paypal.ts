import { createHash } from 'node:crypto';
import { orderHistory, orders, payments, refunds, webhookEvents } from '@tix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { orderAccessToken, orderUrl } from '../orders/access';
import { recordPayment } from '../orders/fulfillment';
import { getSecretSetting, getSetting } from '../settings';

/**
 * PayPal Orders API v2 – server-side redirect flow (no client SDK):
 *
 *  1. `startPayPalPayment` creates a PayPal order for a PENDING shop order and returns the
 *     approval link (payer-action). A `payments` row (CREATED) remembers the PayPal order id.
 *  2. PayPal redirects the buyer back to `/api/paypal/return`, which calls
 *     `completePayPalPayment` → capture → `recordPayment` (order PAID, seats SOLD).
 *  3. Webhooks (`handlePayPalWebhook`, signature verified via PayPal's verification API)
 *     cover buyers who never come back and asynchronous capture results.
 *  4. Before the dunning job expires a pending order it calls `reconcilePayPalOrder`, which
 *     captures approved-but-uncaptured payments.
 *
 * All calls are idempotent (PayPal-Request-Id, unique provider ids, webhook inbox).
 */

const API_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

const REQUEST_TIMEOUT_MS = 20_000;

interface PayPalConfig {
  environment: 'sandbox' | 'live';
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookId: string | null;
  brandName: string | null;
}

export class PayPalApiError extends Error {
  override name = 'PayPalApiError';
  constructor(
    readonly status: number,
    readonly issue: string | null,
    readonly debugId: string | null,
    message: string,
  ) {
    super(message);
  }
}

async function loadConfig(ctx: CoreContext): Promise<PayPalConfig> {
  const [settings, credentials] = await Promise.all([
    getSetting(ctx, 'paypal'),
    getSecretSetting(ctx, 'paypal.credentials'),
  ]);
  if (!settings.clientId || !credentials?.clientSecret) {
    throw new DomainError('PAYPAL_NOT_CONFIGURED', 'PayPal is not configured', 503);
  }
  return {
    environment: settings.environment,
    baseUrl: API_BASE[settings.environment],
    clientId: settings.clientId,
    clientSecret: credentials.clientSecret,
    webhookId: settings.webhookId || null,
    brandName: settings.brandName || null,
  };
}

function tokenCacheKey(ctx: CoreContext, config: PayPalConfig): string {
  const id = createHash('sha256')
    .update(`${config.environment}:${config.clientId}:${config.clientSecret}`)
    .digest('hex')
    .slice(0, 32);
  return ctx.keys.providerToken('paypal', id);
}

async function accessToken(ctx: CoreContext, config: PayPalConfig, fresh = false): Promise<string> {
  const cacheKey = tokenCacheKey(ctx, config);
  if (!fresh) {
    const cached = await ctx.redis.get(cacheKey);
    if (cached) return cached;
  }
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new PayPalApiError(
      res.status,
      'AUTHENTICATION_FAILURE',
      null,
      body.error_description ?? `PayPal authentication failed (${res.status})`,
    );
  }
  const ttl = Math.max(60, (body.expires_in ?? 3600) - 120);
  await ctx.redis.set(cacheKey, body.access_token, 'EX', ttl);
  return body.access_token;
}

async function api<T>(
  ctx: CoreContext,
  config: PayPalConfig,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; requestId?: string } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const token = await accessToken(ctx, config, attempt > 1);
    const res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        prefer: 'return=representation',
        ...(options.requestId ? { 'paypal-request-id': options.requestId } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 && attempt === 1) continue;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const details = json.details as { issue?: string; description?: string }[] | undefined;
      throw new PayPalApiError(
        res.status,
        details?.[0]?.issue ?? (json.name as string | undefined) ?? null,
        (json.debug_id as string | undefined) ?? null,
        details?.[0]?.description ??
          (json.message as string | undefined) ??
          `PayPal request failed (${res.status})`,
      );
    }
    return json as T;
  }
}

// ─── Amounts ────────────────────────────────────────────────────────────────

/** Cents → PayPal decimal string (all supported currencies use 2 decimals). */
export function toPayPalAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** PayPal decimal string → cents without floating point errors. */
export function fromPayPalAmount(value: string): number {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid PayPal amount "${value}"`);
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -cents : cents;
}

// ─── PayPal payloads (subset) ───────────────────────────────────────────────

interface PayPalLink {
  href: string;
  rel: string;
}
interface PayPalCapture {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
  amount: { currency_code: string; value: string };
  create_time?: string;
  status_details?: { reason?: string };
}
interface PayPalOrder {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  links?: PayPalLink[];
  purchase_units?: { custom_id?: string; payments?: { captures?: PayPalCapture[] } }[];
}

const approveLink = (order: PayPalOrder) =>
  order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
const firstCapture = (order: PayPalOrder) => order.purchase_units?.[0]?.payments?.captures?.[0];

// ─── Start payment ──────────────────────────────────────────────────────────

export type StartPayPalResult =
  | { status: 'REDIRECT'; url: string }
  /** Already paid / capture pending – show the order page. */
  | { status: 'DONE' };

/** Creates (or resumes) the PayPal order for a pending shop order; returns the approval URL. */
export async function startPayPalPayment(
  ctx: CoreContext,
  orderId: string,
): Promise<StartPayPalResult> {
  const config = await loadConfig(ctx);
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (order.status === 'PAID') return { status: 'DONE' };
  if (order.status !== 'PENDING' || order.paymentMethod !== 'PAYPAL') {
    throw new DomainError('ORDER_NOT_PAYABLE', 'This order cannot be paid any more', 409);
  }
  const paypal = await getSetting(ctx, 'paypal');
  if (Date.now() - order.createdAt.getTime() > paypal.approvalTimeoutSeconds * 1000) {
    throw new DomainError('ORDER_NOT_PAYABLE', 'The payment window of this order has expired', 409);
  }

  // Resume an open attempt instead of creating a second PayPal order.
  const attempts = await ctx.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, order.id),
        eq(payments.method, 'PAYPAL'),
        inArray(payments.status, ['CREATED', 'APPROVED']),
      ),
    );
  for (const attempt of attempts) {
    if (!attempt.providerOrderId) continue;
    const remote = await api<PayPalOrder>(
      ctx,
      config,
      'GET',
      `/v2/checkout/orders/${encodeURIComponent(attempt.providerOrderId)}`,
    ).catch(() => null);
    if (!remote) continue;
    if (remote.status === 'APPROVED' || remote.status === 'COMPLETED') {
      const result = await completePayPalPayment(ctx, order.id, remote.id);
      if (result.status === 'PAID' || result.status === 'PENDING') return { status: 'DONE' };
      if (result.status === 'RETRY' && result.url) return { status: 'REDIRECT', url: result.url };
      continue;
    }
    const link = approveLink(remote);
    if (link && (remote.status === 'PAYER_ACTION_REQUIRED' || remote.status === 'CREATED')) {
      return { status: 'REDIRECT', url: link };
    }
  }

  const base = requireCapability(ctx, 'appUrl');
  const general = await getSetting(ctx, 'general');
  // PayPal appends `token` (its order id) and `PayerID`; `t` authorises the order page.
  const returnUrl = new URL(`${base}/api/paypal/return`);
  returnUrl.searchParams.set('order', order.id);
  returnUrl.searchParams.set('t', orderAccessToken(ctx, order.id));
  const cancelUrl = orderUrl(ctx, {
    id: order.id,
    orderNumber: order.orderNumber,
    locale: order.locale,
  });
  const created = await api<PayPalOrder>(ctx, config, 'POST', '/v2/checkout/orders', {
    requestId: `tix-create-${order.id}-${attempts.length + 1}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: order.orderNumber,
          invoice_id: order.orderNumber,
          custom_id: order.id,
          description: `${paypal.brandName || general.shopName} ${order.orderNumber}`.slice(0, 127),
          amount: { currency_code: order.currency, value: toPayPalAmount(order.totalGross) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: (config.brandName ?? general.shopName).slice(0, 127),
            locale: order.locale === 'de' ? 'de-DE' : 'en-US',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: returnUrl.toString(),
            cancel_url: `${cancelUrl}&paypal=cancelled`,
          },
        },
      },
    },
  });
  const link = approveLink(created);
  if (!link) throw new PayPalApiError(502, null, null, 'PayPal returned no approval link');
  await ctx.db
    .insert(payments)
    .values({
      orderId: order.id,
      method: 'PAYPAL',
      status: 'CREATED',
      amount: order.totalGross,
      currency: order.currency,
      providerOrderId: created.id,
      providerResponse: { id: created.id, status: created.status },
    })
    .onConflictDoNothing();
  return { status: 'REDIRECT', url: link };
}

// ─── Capture ────────────────────────────────────────────────────────────────

export type CompletePayPalResult =
  | { status: 'PAID' }
  /** Capture accepted but pending at PayPal (e.g. review) – completed by webhook. */
  | { status: 'PENDING' }
  /** Funding failed – the buyer may choose another funding source at PayPal. */
  | { status: 'RETRY'; url: string | null }
  | { status: 'NOT_APPROVED' }
  | { status: 'FAILED'; reason: string }
  /** Order was cancelled/expired meanwhile; captured money has been refunded. */
  | { status: 'NOT_PAYABLE' };

export async function completePayPalPayment(
  ctx: CoreContext,
  orderId: string,
  paypalOrderId: string,
): Promise<CompletePayPalResult> {
  const config = await loadConfig(ctx);
  const [attempt] = await ctx.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.method, 'PAYPAL'),
        eq(payments.providerOrderId, paypalOrderId),
      ),
    );
  if (!attempt) throw new DomainError('PAYMENT_NOT_FOUND', 'Payment not found', 404);
  if (attempt.status === 'CAPTURED') return { status: 'PAID' };
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (order.status === 'PAID') return { status: 'PAID' };
  // Never take money for an order that no longer holds seats.
  if (order.status !== 'PENDING') return { status: 'NOT_PAYABLE' };

  let remote: PayPalOrder;
  try {
    remote = await api<PayPalOrder>(
      ctx,
      config,
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
      { requestId: `tix-capture-${paypalOrderId}`, body: {} },
    );
  } catch (err) {
    if (!(err instanceof PayPalApiError)) throw err;
    if (err.issue === 'ORDER_ALREADY_CAPTURED') {
      remote = await api<PayPalOrder>(
        ctx,
        config,
        'GET',
        `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
      );
    } else if (err.issue === 'INSTRUMENT_DECLINED') {
      const current = await api<PayPalOrder>(
        ctx,
        config,
        'GET',
        `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
      ).catch(() => null);
      return { status: 'RETRY', url: current ? approveLink(current) : null };
    } else if (err.issue === 'ORDER_NOT_APPROVED') {
      return { status: 'NOT_APPROVED' };
    } else {
      await markAttempt(ctx, attempt.id, 'FAILED', err.issue ?? 'CAPTURE_FAILED', err.message);
      return { status: 'FAILED', reason: err.issue ?? 'CAPTURE_FAILED' };
    }
  }
  return applyCapture(ctx, order, attempt.id, paypalOrderId, firstCapture(remote));
}

async function applyCapture(
  ctx: CoreContext,
  order: typeof orders.$inferSelect,
  attemptId: string,
  paypalOrderId: string,
  capture: PayPalCapture | undefined,
): Promise<CompletePayPalResult> {
  if (!capture) {
    await markAttempt(ctx, attemptId, 'FAILED', 'NO_CAPTURE', 'PayPal returned no capture');
    return { status: 'FAILED', reason: 'NO_CAPTURE' };
  }
  const response = {
    orderId: paypalOrderId,
    captureId: capture.id,
    status: capture.status,
    amount: capture.amount,
    reason: capture.status_details?.reason ?? null,
  };
  if (capture.status === 'PENDING') {
    await ctx.db
      .update(payments)
      .set({
        status: 'APPROVED',
        providerCaptureId: capture.id,
        providerResponse: response,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, attemptId), inArray(payments.status, ['CREATED', 'APPROVED'])));
    return { status: 'PENDING' };
  }
  if (capture.status !== 'COMPLETED') {
    await markAttempt(
      ctx,
      attemptId,
      'FAILED',
      capture.status,
      capture.status_details?.reason ?? null,
    );
    return { status: 'FAILED', reason: capture.status };
  }
  const amount = fromPayPalAmount(capture.amount.value);
  const result = await recordPayment(ctx, {
    orderId: order.id,
    amount,
    currency: capture.amount.currency_code,
    method: 'PAYPAL',
    capturedAt: capture.create_time ? new Date(capture.create_time) : new Date(),
    providerOrderId: paypalOrderId,
    providerCaptureId: capture.id,
    providerResponse: response,
    actor: { type: 'WEBHOOK' },
  });
  if (result.status === 'NOT_PAYABLE') {
    await refundOrphanCapture(ctx, order, attemptId, capture, amount);
    return { status: 'NOT_PAYABLE' };
  }
  return result.status === 'PARTIAL' ? { status: 'PENDING' } : { status: 'PAID' };
}

async function markAttempt(
  ctx: CoreContext,
  paymentId: string,
  status: 'FAILED' | 'CANCELLED',
  code: string | null,
  message: string | null,
): Promise<void> {
  await ctx.db
    .update(payments)
    .set({ status, failureCode: code, failureMessage: message, updatedAt: new Date() })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, ['CREATED', 'APPROVED'])));
}

/**
 * Money arrived for an order that was cancelled/expired in the meantime (race between the
 * buyer's late approval and the expiry job): refund it immediately and leave a trace.
 */
async function refundOrphanCapture(
  ctx: CoreContext,
  order: typeof orders.$inferSelect,
  attemptId: string,
  capture: PayPalCapture,
  amount: number,
): Promise<void> {
  const config = await loadConfig(ctx);
  let refundId: string | null = null;
  let failure: string | null = null;
  try {
    const refund = await api<{ id: string; status: string }>(
      ctx,
      config,
      'POST',
      `/v2/payments/captures/${encodeURIComponent(capture.id)}/refund`,
      { requestId: `tix-refund-${capture.id}`, body: {} },
    );
    refundId = refund.id;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  await ctx.db
    .update(payments)
    .set({
      status: refundId ? 'REFUNDED' : 'CAPTURED',
      providerCaptureId: capture.id,
      capturedAt: new Date(),
      failureMessage: failure,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, attemptId));
  await ctx.db.insert(refunds).values({
    orderId: order.id,
    paymentId: attemptId,
    method: 'PAYPAL',
    status: refundId ? 'SUCCEEDED' : 'FAILED',
    amount,
    currency: capture.amount.currency_code,
    reason: 'Payment received after the order was cancelled/expired',
    providerRefundId: refundId,
    failureMessage: failure,
    processedAt: new Date(),
  });
  await ctx.db.insert(orderHistory).values({
    orderId: order.id,
    type: 'late_payment_refunded',
    actorType: 'SYSTEM',
    data: { captureId: capture.id, amount, refundId, failure },
  });
}

// ─── Reconciliation (expiry job) ────────────────────────────────────────────

/**
 * Checks open PayPal attempts of a pending order at PayPal and captures approved ones.
 * Returns true when the order must NOT be expired (paid or capture pending).
 */
export async function reconcilePayPalOrder(ctx: CoreContext, orderId: string): Promise<boolean> {
  const attempts = await ctx.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.method, 'PAYPAL'),
        inArray(payments.status, ['CREATED', 'APPROVED']),
      ),
    );
  if (attempts.length === 0) return false;
  const config = await loadConfig(ctx);
  let keep = false;
  for (const attempt of attempts) {
    if (!attempt.providerOrderId) continue;
    if (attempt.status === 'APPROVED' && attempt.providerCaptureId) {
      // Capture pending at PayPal: completed/denied by webhook – keep the seats meanwhile.
      keep = true;
      continue;
    }
    const remote = await api<PayPalOrder>(
      ctx,
      config,
      'GET',
      `/v2/checkout/orders/${encodeURIComponent(attempt.providerOrderId)}`,
    );
    if (remote.status === 'APPROVED' || remote.status === 'COMPLETED') {
      const result = await completePayPalPayment(ctx, orderId, remote.id);
      if (result.status === 'PAID' || result.status === 'PENDING') keep = true;
    } else {
      await markAttempt(ctx, attempt.id, 'CANCELLED', 'NOT_APPROVED', null);
    }
  }
  return keep;
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource?: {
    id?: string;
    status?: string;
    amount?: { currency_code: string; value: string };
    create_time?: string;
    custom_id?: string;
    supplementary_data?: { related_ids?: { order_id?: string } };
    status_details?: { reason?: string };
    links?: PayPalLink[];
  };
}

export type WebhookOutcome = 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'INVALID_SIGNATURE';

/**
 * Verifies and processes a PayPal webhook. Signature verification uses PayPal's
 * `verify-webhook-signature` API with the configured webhook id; unverifiable events are
 * stored for audit but never acted upon.
 */
export async function handlePayPalWebhook(
  ctx: CoreContext,
  headers: Headers,
  rawBody: string,
): Promise<WebhookOutcome> {
  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch {
    throw new DomainError('INVALID_JSON', 'Invalid webhook payload', 400);
  }
  if (!event?.id || !event.event_type) {
    throw new DomainError('INVALID_WEBHOOK', 'Invalid webhook payload', 400);
  }
  const config = await loadConfig(ctx);
  const valid = await verifyWebhookSignature(ctx, config, headers, event);

  const [inserted] = await ctx.db
    .insert(webhookEvents)
    .values({
      provider: 'paypal',
      externalId: event.id,
      eventType: event.event_type,
      payload: event,
      signatureValid: valid,
      status: valid ? 'RECEIVED' : 'IGNORED',
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (!valid) return 'INVALID_SIGNATURE';
  let inboxId = inserted?.id;
  if (!inboxId) {
    const [existing] = await ctx.db
      .select({ id: webhookEvents.id, status: webhookEvents.status })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, 'paypal'), eq(webhookEvents.externalId, event.id)));
    if (!existing || existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
      return 'DUPLICATE';
    }
    inboxId = existing.id;
  }

  try {
    const handled = await processWebhookEvent(ctx, event);
    await ctx.db
      .update(webhookEvents)
      .set({
        status: handled ? 'PROCESSED' : 'IGNORED',
        attempts: sql`${webhookEvents.attempts} + 1`,
        processedAt: new Date(),
        lastError: null,
      })
      .where(eq(webhookEvents.id, inboxId));
    return handled ? 'PROCESSED' : 'IGNORED';
  } catch (err) {
    await ctx.db
      .update(webhookEvents)
      .set({
        status: 'FAILED',
        attempts: sql`${webhookEvents.attempts} + 1`,
        lastError: err instanceof Error ? err.message.slice(0, 1000) : String(err),
      })
      .where(eq(webhookEvents.id, inboxId));
    throw err; // non-2xx → PayPal retries the delivery
  }
}

async function verifyWebhookSignature(
  ctx: CoreContext,
  config: PayPalConfig,
  headers: Headers,
  event: PayPalWebhookEvent,
): Promise<boolean> {
  if (!config.webhookId) return false;
  const header = (name: string) => headers.get(name) ?? '';
  const required = [
    'paypal-auth-algo',
    'paypal-cert-url',
    'paypal-transmission-id',
    'paypal-transmission-sig',
    'paypal-transmission-time',
  ];
  if (required.some((name) => !header(name))) return false;
  const result = await api<{ verification_status?: string }>(
    ctx,
    config,
    'POST',
    '/v1/notifications/verify-webhook-signature',
    {
      body: {
        auth_algo: header('paypal-auth-algo'),
        cert_url: header('paypal-cert-url'),
        transmission_id: header('paypal-transmission-id'),
        transmission_sig: header('paypal-transmission-sig'),
        transmission_time: header('paypal-transmission-time'),
        webhook_id: config.webhookId,
        webhook_event: event,
      },
    },
  );
  return result.verification_status === 'SUCCESS';
}

async function attemptByPayPalOrder(ctx: CoreContext, paypalOrderId: string | undefined) {
  if (!paypalOrderId) return null;
  const [row] = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.method, 'PAYPAL'), eq(payments.providerOrderId, paypalOrderId)));
  return row ?? null;
}

async function processWebhookEvent(ctx: CoreContext, event: PayPalWebhookEvent): Promise<boolean> {
  const resource = event.resource ?? {};
  switch (event.event_type) {
    case 'CHECKOUT.ORDER.APPROVED': {
      const attempt = await attemptByPayPalOrder(ctx, resource.id);
      if (!attempt) return false;
      await completePayPalPayment(ctx, attempt.orderId, attempt.providerOrderId!);
      return true;
    }
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const attempt = await attemptByPayPalOrder(
        ctx,
        resource.supplementary_data?.related_ids?.order_id,
      );
      if (!attempt || !resource.id || !resource.amount) return false;
      if (attempt.status === 'CAPTURED') return true;
      const [order] = await ctx.db.select().from(orders).where(eq(orders.id, attempt.orderId));
      if (!order) return false;
      await applyCapture(ctx, order, attempt.id, attempt.providerOrderId!, {
        id: resource.id,
        status: 'COMPLETED',
        amount: resource.amount,
        create_time: resource.create_time,
      });
      return true;
    }
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED': {
      const attempt = await attemptByPayPalOrder(
        ctx,
        resource.supplementary_data?.related_ids?.order_id,
      );
      if (!attempt) return false;
      await markAttempt(
        ctx,
        attempt.id,
        'FAILED',
        event.event_type,
        resource.status_details?.reason ?? null,
      );
      await ctx.db.insert(orderHistory).values({
        orderId: attempt.orderId,
        type: 'payment_failed',
        actorType: 'WEBHOOK',
        data: { provider: 'paypal', event: event.event_type, captureId: resource.id ?? null },
      });
      return true;
    }
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      // Refunds are initiated in the admin (phase 5); external ones are logged for review.
      // REFUNDED: resource = refund, its "up" link points to the capture.
      const captureId =
        event.event_type === 'PAYMENT.CAPTURE.REVERSED'
          ? resource.id
          : /\/captures\/([^/?]+)/.exec(
              resource.links?.find((l) => l.rel === 'up')?.href ?? '',
            )?.[1];
      const [payment] = captureId
        ? await ctx.db.select().from(payments).where(eq(payments.providerCaptureId, captureId))
        : [];
      if (!payment) return false;
      await ctx.db.insert(orderHistory).values({
        orderId: payment.orderId,
        type: 'external_refund_notice',
        actorType: 'WEBHOOK',
        data: { provider: 'paypal', event: event.event_type, amount: resource.amount ?? null },
      });
      return true;
    }
    default:
      return false;
  }
}
