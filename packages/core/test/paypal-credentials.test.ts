import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCoreLogger } from '../src/log';
import {
  completePayPalPayment,
  isCredentialRejection,
  isTransientPayPalError,
  PayPalApiError,
  PayPalCredentialsError,
  requestPayPalToken,
  resetCredentialLogThrottle,
} from '../src/payments/paypal';

vi.mock('../src/settings', () => ({
  getSetting: vi.fn(async () => ({
    environment: 'sandbox',
    clientId: 'id',
    webhookId: '',
    brandName: '',
  })),
  getSecretSetting: vi.fn(async () => ({ clientSecret: 'super-secret' })),
}));

const config = {
  environment: 'sandbox' as const,
  baseUrl: 'https://api-m.sandbox.paypal.com',
  clientId: 'id',
  clientSecret: 'super-secret',
};

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

beforeEach(() => resetCredentialLogThrottle());
afterEach(() => {
  vi.unstubAllGlobals();
  setCoreLogger(undefined);
});

describe('isCredentialRejection', () => {
  it('detects 401, invalid_client and AUTHENTICATION_FAILURE', () => {
    expect(isCredentialRejection(401, {})).toBe(true);
    expect(isCredentialRejection(400, { error: 'invalid_client' })).toBe(true);
    expect(isCredentialRejection(403, { name: 'AUTHENTICATION_FAILURE' })).toBe(true);
    expect(isCredentialRejection(500, {})).toBe(false);
    expect(isCredentialRejection(429, { error: 'rate' })).toBe(false);
  });
});

describe('requestPayPalToken', () => {
  it('returns the token on success', async () => {
    mockFetch(200, { access_token: 'tok', expires_in: 300 });
    await expect(requestPayPalToken(config, true)).resolves.toEqual({
      token: 'tok',
      expiresIn: 300,
    });
  });

  it('throws a typed credentials error on 401 without leaking the secret', async () => {
    mockFetch(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    const err = await requestPayPalToken(config, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalCredentialsError);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalCredentialsError).kind).toBe('credentials');
    expect((err as PayPalCredentialsError).environment).toBe('sandbox');
    expect(String((err as Error).message)).not.toContain('super-secret');
  });

  it('keeps other failures as plain PayPalApiError', async () => {
    mockFetch(503, {});
    const err = await requestPayPalToken(config, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).not.toBeInstanceOf(PayPalCredentialsError);
  });
});

describe('credential rejection log throttle', () => {
  function captureLog() {
    const error = vi.fn();
    setCoreLogger({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error });
    return error;
  }

  it('logs once per minute per environment and client id, but always throws', async () => {
    const error = captureLog();
    mockFetch(401, { error: 'invalid_client' });
    for (let i = 0; i < 3; i += 1) {
      await expect(requestPayPalToken(config)).rejects.toBeInstanceOf(PayPalCredentialsError);
    }
    expect(error).toHaveBeenCalledTimes(1);
    // A different client id is its own key.
    await expect(requestPayPalToken({ ...config, clientId: 'other' })).rejects.toBeInstanceOf(
      PayPalCredentialsError,
    );
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('logs again after the interval', async () => {
    const error = captureLog();
    mockFetch(401, {});
    vi.useFakeTimers();
    try {
      await requestPayPalToken(config).catch(() => undefined);
      vi.setSystemTime(Date.now() + 61_000);
      await requestPayPalToken(config).catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('isTransientPayPalError', () => {
  it('retries credential errors (fixable in the admin) and keeps other 4xx final', () => {
    expect(isTransientPayPalError(new PayPalCredentialsError('sandbox', 401, 'x'))).toBe(true);
    expect(isTransientPayPalError(new PayPalApiError(503, null, null, 'x'))).toBe(true);
    expect(isTransientPayPalError(new PayPalApiError(422, 'INSTRUMENT_DECLINED', null, 'x'))).toBe(
      false,
    );
  });
});

describe('completePayPalPayment with rejected credentials', () => {
  it('throws and leaves the attempt open (not FAILED)', async () => {
    setCoreLogger({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });
    mockFetch(401, { error: 'invalid_client' });
    const attempt = { id: 'pay-1', status: 'CREATED', adjustmentId: null };
    const order = { id: 'order-1', status: 'PENDING' };
    const rows = [[attempt], [order]];
    const update = vi.fn();
    const ctx = {
      redis: { get: vi.fn(async () => null), set: vi.fn() },
      keys: { providerToken: () => 'k' },
      db: {
        select: () => ({ from: () => ({ where: async () => rows.shift() }) }),
        update,
      },
    };
    await expect(completePayPalPayment(ctx as never, 'order-1', 'PP-1')).rejects.toBeInstanceOf(
      PayPalCredentialsError,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
