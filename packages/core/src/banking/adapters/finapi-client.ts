import { randomUUID } from 'node:crypto';

/**
 * Minimal finAPI client: Access V2 (OAuth, users, bank connections, accounts, transactions)
 * and Web Form 2.0 (bank connection import, background update tasks). Only account
 * information is used – no payments. Endpoints follow the published OpenAPI specs
 * (`/api-docs/openapi-access-v2.yaml`, Web Form `/v3/api-docs.yaml`).
 */

export type FinApiEnvironment = 'sandbox' | 'live';

export const FINAPI_HOSTS: Record<FinApiEnvironment, { access: string; webForm: string }> = {
  sandbox: { access: 'https://sandbox.finapi.io', webForm: 'https://webform-sandbox.finapi.io' },
  live: { access: 'https://live.finapi.io', webForm: 'https://webform-live.finapi.io' },
};

export interface FinApiWebForm {
  id: string;
  url: string;
  createdAt?: string;
  expiresAt: string;
  type?: string;
  /** NOT_YET_OPENED, IN_PROGRESS, COMPLETED, COMPLETED_WITH_ERROR, EXPIRED, ABORTED, CANCELLED */
  status: string;
  payload?: {
    bankConnectionId?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  } | null;
}

export interface FinApiTask {
  id: string;
  type?: string;
  /** NOT_YET_STARTED, IN_PROGRESS, WEB_FORM_REQUIRED, COMPLETED, COMPLETED_WITH_ERROR */
  status: string;
  payload?: {
    bankConnectionId?: number | null;
    webForm?: { id: string; url: string; status: string } | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  } | null;
}

export interface FinApiBankConnectionInterface {
  bankingInterface: string;
  aisConsent?: { status: string; expiresAt?: string | null } | null;
  userActionRequired?: boolean;
  lastManualUpdate?: { result: string; errorMessage?: string | null; timestamp?: string } | null;
  lastAutoUpdate?: { result: string; errorMessage?: string | null; timestamp?: string } | null;
}

export interface FinApiBankConnection {
  id: number;
  updateStatus?: string;
  accountIds?: number[];
  bank?: { name?: string | null; bic?: string | null; blz?: string | null } | null;
  interfaces?: FinApiBankConnectionInterface[];
}

export interface FinApiAccount {
  id: number;
  bankConnectionId: number;
  iban?: string | null;
  accountName?: string | null;
  accountCurrency?: string | null;
  accountType?: string | null;
}

export interface FinApiTransaction {
  id: number;
  accountId: number;
  valueDate?: string | null;
  bankBookingDate?: string | null;
  finapiBookingDate?: string | null;
  amount: number;
  currency?: string | null;
  purpose?: string | null;
  counterpartName?: string | null;
  counterpartIban?: string | null;
  counterpartBic?: string | null;
  counterpartAccountNumber?: string | null;
  endToEndReference?: string | null;
  typeCodeZka?: string | null;
  bankTransactionCode?: string | null;
  type?: string | null;
  isAdjustingEntry?: boolean | null;
  isPotentialDuplicate?: boolean | null;
}

export class FinApiError extends Error {
  override name = 'FinApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

type FetchFn = typeof fetch;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Process-wide token cache (tokens are valid for the same credentials until expiry). */
const tokenCache = new Map<string, CachedToken>();

export function clearFinApiTokenCache(): void {
  tokenCache.clear();
}

export class FinApiClient {
  private readonly hosts: { access: string; webForm: string };
  private readonly fetchImpl: FetchFn;

  constructor(
    private readonly options: {
      environment: FinApiEnvironment;
      clientId: string;
      clientSecret: string;
      fetch?: FetchFn;
      timeoutMs?: number;
    },
  ) {
    this.hosts = FINAPI_HOSTS[options.environment];
    this.fetchImpl = options.fetch ?? fetch;
  }

  // ── OAuth ────────────────────────────────────────────────────────────────
  private async token(cacheKey: string, form: Record<string, string>): Promise<string> {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      ...form,
    });
    const res = await this.raw(`${this.hosts.access}/api/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token)
      throw new FinApiError(res.status, 'NO_TOKEN', 'No access token received');
    const lifetime = json.expires_in && json.expires_in > 0 ? json.expires_in * 1000 : 3600_000;
    tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + lifetime });
    return json.access_token;
  }

  clientToken(): Promise<string> {
    return this.token(`${this.options.environment}:${this.options.clientId}:client`, {
      grant_type: 'client_credentials',
    });
  }

  userToken(userId: string, password: string): Promise<string> {
    return this.token(`${this.options.environment}:${this.options.clientId}:user:${userId}`, {
      grant_type: 'password',
      username: userId,
      password,
    });
  }

  forgetUserToken(userId: string): void {
    tokenCache.delete(`${this.options.environment}:${this.options.clientId}:user:${userId}`);
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  private async raw(url: string, init: RequestInit): Promise<Response> {
    const requestId = randomUUID();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { accept: 'application/json', 'x-request-id': requestId, ...init.headers },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new FinApiError(
        0,
        'NETWORK',
        `finAPI not reachable: ${(err as Error).message}`,
        requestId,
      );
    }
    if (res.ok) return res;
    let code = `HTTP_${res.status}`;
    let message = res.statusText || 'finAPI request failed';
    try {
      const body = (await res.json()) as {
        errors?: { message?: string; code?: string; field?: string }[];
        code?: string;
        description?: string;
        error?: string;
        error_description?: string;
      };
      if (body.errors?.length) {
        code = body.errors[0]!.code ?? code;
        message = body.errors
          .map((e) => [e.field, e.message].filter(Boolean).join(': '))
          .join('; ');
      } else if (body.code) {
        code = body.code;
        message = body.description ?? message;
      } else if (body.error) {
        code = body.error.toUpperCase();
        message = body.error_description ?? body.error;
      }
    } catch {
      // Non-JSON error body.
    }
    throw new FinApiError(res.status, code, message.slice(0, 1000), requestId);
  }

  private async json<T>(
    token: string,
    url: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.raw(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ── Users ────────────────────────────────────────────────────────────────
  /** Creates a finAPI user; id and password are generated by finAPI. */
  async createUser(): Promise<{ id: string; password: string }> {
    const token = await this.clientToken();
    const user = await this.json<{ id: string; password: string }>(
      token,
      `${this.hosts.access}/api/v2/users`,
      { method: 'POST', body: { isAutoUpdateEnabled: false } },
    );
    if (!user.id || !user.password)
      throw new FinApiError(500, 'NO_USER', 'User creation returned no credentials');
    return { id: user.id, password: user.password };
  }

  /** Deletes the user incl. all bank connections and consents at the bank. */
  async deleteUser(userToken: string): Promise<void> {
    await this.json(userToken, `${this.hosts.access}/api/v2/users`, { method: 'DELETE' });
  }

  // ── Web Form 2.0 ─────────────────────────────────────────────────────────
  createBankConnectionImport(
    userToken: string,
    body: Record<string, unknown>,
  ): Promise<FinApiWebForm> {
    return this.json(userToken, `${this.hosts.webForm}/api/webForms/bankConnectionImport`, {
      method: 'POST',
      body,
    });
  }

  getWebForm(userToken: string, id: string): Promise<FinApiWebForm> {
    return this.json(userToken, `${this.hosts.webForm}/api/webForms/${encodeURIComponent(id)}`);
  }

  startBackgroundUpdate(userToken: string, body: Record<string, unknown>): Promise<FinApiTask> {
    return this.json(userToken, `${this.hosts.webForm}/api/tasks/backgroundUpdate`, {
      method: 'POST',
      body,
    });
  }

  getTask(userToken: string, id: string): Promise<FinApiTask> {
    return this.json(userToken, `${this.hosts.webForm}/api/tasks/${encodeURIComponent(id)}`);
  }

  // ── Access: bank connections, accounts, transactions ─────────────────────
  getBankConnection(userToken: string, id: number): Promise<FinApiBankConnection> {
    return this.json(userToken, `${this.hosts.access}/api/v2/bankConnections/${id}`);
  }

  async listAccounts(userToken: string, bankConnectionId: number): Promise<FinApiAccount[]> {
    const res = await this.json<{ accounts?: FinApiAccount[] }>(
      userToken,
      `${this.hosts.access}/api/v2/accounts?bankConnectionIds=${bankConnectionId}`,
    );
    return res.accounts ?? [];
  }

  /** All booked transactions of an account since a date (bank view, all pages). */
  async listTransactions(
    userToken: string,
    params: { accountId: number; minBankBookingDate: string; maxPages?: number },
  ): Promise<FinApiTransaction[]> {
    const out: FinApiTransaction[] = [];
    const maxPages = params.maxPages ?? 50;
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({
        view: 'bankView',
        accountIds: String(params.accountId),
        minBankBookingDate: params.minBankBookingDate,
        page: String(page),
        perPage: '500',
      });
      query.append('order', 'bankBookingDate,asc');
      query.append('order', 'id,asc');
      const res = await this.json<{
        transactions?: FinApiTransaction[];
        paging?: { page: number; pageCount: number };
      }>(userToken, `${this.hosts.access}/api/v2/transactions?${query.toString()}`);
      out.push(...(res.transactions ?? []));
      if (!res.paging || page >= res.paging.pageCount) break;
    }
    return out;
  }

  webFormUrl(url: string, params: { language?: string; redirectUrl?: string }): string {
    const target = new URL(url);
    if (params.language) target.searchParams.set('language', params.language);
    if (params.redirectUrl) target.searchParams.set('redirectUrl', params.redirectUrl);
    return target.toString();
  }
}
