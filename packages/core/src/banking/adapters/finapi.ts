import { setTimeout as delay } from 'node:timers/promises';
import { bankConnections } from '@tix/db';
import {
  finApiConfigSchema,
  finApiStateSchema,
  normalizeIban,
  type BankConnectionSecrets,
  type FinApiConfig,
  type FinApiState,
} from '@tix/shared';
import { eq } from 'drizzle-orm';
import type { CoreContext } from '../../context';
import {
  BankSyncError,
  decryptConnectionSecrets,
  encryptConnectionSecrets,
  loadConnection,
  patchConnectionState,
  replaceConnectionState,
  type BankAccountRow,
  type BankConnectionRow,
} from '../connections';
import { addDaysIso, cleanText, todayIso } from '../text';
import type { ParsedTransaction } from '../types';
import {
  FinApiClient,
  FinApiError,
  type FinApiTask,
  type FinApiTransaction,
  type FinApiWebForm,
} from './finapi-client';

/**
 * PSD2 account access through finAPI (Access V2 + Web Form 2.0) for installations without
 * an own PSD2 licence:
 *  - one finAPI user per connection (created on first use; password stored encrypted),
 *  - bank login + consent via a Web Form link opened by the admin (import / renewal),
 *  - each sync optionally triggers a background update (≤ 4×/day without the user) and
 *    downloads booked transactions of the receiving account,
 *  - consent expiry is mirrored to `bank_connections.consent_expires_at`.
 */

type FinApiSecrets = Extract<BankConnectionSecrets, { adapter: 'PSD2_FINAPI' }>;

export interface FinApiDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  /** Max. wait for a background update task. */
  taskTimeoutMs?: number;
  taskPollMs?: number;
}

const FINAL_WEB_FORM = ['COMPLETED', 'COMPLETED_WITH_ERROR', 'EXPIRED', 'ABORTED', 'CANCELLED'];
const FINAL_TASK = ['WEB_FORM_REQUIRED', 'COMPLETED', 'COMPLETED_WITH_ERROR'];

function client(config: FinApiConfig, secrets: FinApiSecrets, deps: FinApiDeps): FinApiClient {
  return new FinApiClient({
    environment: config.environment,
    clientId: config.clientId,
    clientSecret: secrets.clientSecret,
    fetch: deps.fetch,
  });
}

function parseState(state: unknown): FinApiState {
  const parsed = finApiStateSchema.safeParse(state ?? {});
  return parsed.success ? parsed.data : finApiStateSchema.parse({});
}

interface Loaded {
  connection: BankConnectionRow;
  account: BankAccountRow;
  config: FinApiConfig;
  secrets: FinApiSecrets;
  state: FinApiState;
  api: FinApiClient;
}

async function load(ctx: CoreContext, connectionId: string, deps: FinApiDeps): Promise<Loaded> {
  const loaded = await loadConnection(ctx, connectionId);
  if (!loaded || loaded.connection.adapter !== 'PSD2_FINAPI') {
    throw new BankSyncError('NOT_FOUND', 'finAPI connection not found');
  }
  const config = finApiConfigSchema.parse(loaded.connection.config);
  const secrets = decryptConnectionSecrets(ctx, loaded.connection, 'PSD2_FINAPI');
  if (!secrets) throw new BankSyncError('FINAPI_NO_CREDENTIALS', 'Client secret missing');
  return {
    ...loaded,
    config,
    secrets,
    state: parseState(loaded.connection.state),
    api: client(config, secrets, deps),
  };
}

/** Creates the finAPI user of this connection on first use and returns a user token. */
async function userToken(ctx: CoreContext, l: Loaded): Promise<{ token: string; userId: string }> {
  if (!l.state.userId || !l.secrets.userPassword) {
    const user = await l.api.createUser();
    l.secrets = { ...l.secrets, userPassword: user.password };
    l.state = { ...l.state, userId: user.id };
    await ctx.db
      .update(bankConnections)
      .set({ credentialsEncrypted: encryptConnectionSecrets(ctx, l.connection.id, l.secrets) })
      .where(eq(bankConnections.id, l.connection.id));
    await patchConnectionState(ctx, l.connection.id, { userId: user.id });
  }
  const token = await l.api.userToken(l.state.userId!, l.secrets.userPassword!);
  return { token, userId: l.state.userId! };
}

function webFormState(
  form: FinApiWebForm | { id: string; url: string; status: string; expiresAt?: string },
  purpose: 'IMPORT' | 'UPDATE',
): NonNullable<FinApiState['webForm']> {
  return {
    id: form.id,
    url: form.url,
    status: form.status,
    expiresAt: form.expiresAt ?? new Date(Date.now() + 20 * 60_000).toISOString(),
    purpose,
  };
}

async function pollTask(
  api: FinApiClient,
  token: string,
  task: FinApiTask,
  deps: FinApiDeps,
): Promise<FinApiTask> {
  const sleep = deps.sleep ?? delay;
  const deadline = Date.now() + (deps.taskTimeoutMs ?? 180_000);
  let current = task;
  while (
    !FINAL_TASK.includes(current.status) &&
    !current.payload?.webForm &&
    Date.now() < deadline
  ) {
    await sleep(deps.taskPollMs ?? 2000);
    current = await api.getTask(token, current.id);
  }
  return current;
}

export type FinApiConnectResult =
  { status: 'WEB_FORM'; url: string; expiresAt: string } | { status: 'UP_TO_DATE' };

/**
 * Opens the bank login for the admin: a bank-connection import (first time) or – when a
 * bank connection exists – a background update that yields a Web Form when the bank needs
 * strong customer authentication / consent renewal.
 */
export async function startFinApiWebForm(
  ctx: CoreContext,
  params: { connectionId: string; language: string; returnUrl?: string | null },
  deps: FinApiDeps = {},
): Promise<FinApiConnectResult> {
  const l = await load(ctx, params.connectionId, deps);
  const { token } = await userToken(ctx, l);
  const decorate = (url: string) =>
    l.api.webFormUrl(url, {
      language: params.language === 'de' ? 'de' : 'en',
      redirectUrl: params.returnUrl?.startsWith('https://') ? params.returnUrl : undefined,
    });

  if (l.state.bankConnectionId) {
    const task = await pollTask(
      l.api,
      token,
      await l.api.startBackgroundUpdate(token, {
        bankConnectionId: l.state.bankConnectionId,
        importNewAccountsMode: 'SKIP',
        skipPositionsDownload: true,
        ...(l.config.webFormProfileId ? { profileId: l.config.webFormProfileId } : {}),
      }),
      { ...deps, taskTimeoutMs: Math.min(deps.taskTimeoutMs ?? 60_000, 60_000) },
    );
    const form = task.payload?.webForm;
    if (form) {
      const state = webFormState(form, 'UPDATE');
      await patchConnectionState(ctx, l.connection.id, {
        webForm: state,
        userActionRequired: true,
      });
      return { status: 'WEB_FORM', url: decorate(form.url), expiresAt: state.expiresAt };
    }
    if (task.status === 'COMPLETED') {
      await patchConnectionState(ctx, l.connection.id, {
        userActionRequired: false,
        lastErrorCode: null,
      });
      await refreshFinApiConnection(ctx, l.connection.id, deps);
      return { status: 'UP_TO_DATE' };
    }
    throw new BankSyncError(
      'FINAPI_UPDATE_FAILED',
      task.payload?.errorMessage ?? task.payload?.errorCode ?? `Update task ${task.status}`,
    );
  }

  const base = {
    bankConnectionName: l.account.name.slice(0, 64),
    accountTypes: ['CHECKING'],
    skipPositionsDownload: true,
    loadOwnerData: false,
    maxDaysForDownload: l.config.lookbackDays,
    allowTestBank: l.config.environment === 'sandbox',
    ...(l.config.webFormProfileId ? { profileId: l.config.webFormProfileId } : {}),
  };
  let form: FinApiWebForm;
  try {
    form = await l.api.createBankConnectionImport(token, {
      ...base,
      bank: { search: l.account.iban },
    });
  } catch (err) {
    // Bank not found / ambiguous by IBAN (e.g. sandbox test bank) → let the admin pick it.
    if (err instanceof FinApiError && err.status === 422 && /^BANK_NOT_/.test(err.code)) {
      form = await l.api.createBankConnectionImport(token, base);
    } else throw err;
  }
  const state = webFormState(form, 'IMPORT');
  await patchConnectionState(ctx, l.connection.id, { webForm: state, lastErrorCode: null });
  return { status: 'WEB_FORM', url: decorate(form.url), expiresAt: state.expiresAt };
}

/**
 * Follows up an open Web Form, resolves the bank connection / receiving account and mirrors
 * consent information. Safe to call any time (page load, before each sync).
 */
export async function refreshFinApiConnection(
  ctx: CoreContext,
  connectionId: string,
  deps: FinApiDeps = {},
): Promise<FinApiState> {
  const l = await load(ctx, connectionId, deps);
  if (!l.state.userId || !l.secrets.userPassword) return l.state;
  const { token } = await userToken(ctx, l);
  const patch: Partial<FinApiState> = {};

  const form = l.state.webForm;
  if (form && !FINAL_WEB_FORM.includes(form.status)) {
    try {
      const current = await l.api.getWebForm(token, form.id);
      patch.webForm = { ...form, status: current.status };
      if (FINAL_WEB_FORM.includes(current.status)) {
        const bankConnectionId = current.payload?.bankConnectionId ?? null;
        if (bankConnectionId && form.purpose === 'IMPORT') {
          patch.bankConnectionId = bankConnectionId;
          patch.accountId = null;
        }
        if (current.status === 'COMPLETED') patch.userActionRequired = false;
        patch.lastErrorCode =
          current.payload?.errorCode ?? (current.status === 'COMPLETED' ? null : current.status);
      }
    } catch (err) {
      if (!(err instanceof FinApiError && err.status === 404)) throw err;
      patch.webForm = { ...form, status: 'EXPIRED' };
    }
  }

  const bankConnectionId = patch.bankConnectionId ?? l.state.bankConnectionId;
  if (bankConnectionId) {
    const connection = await l.api.getBankConnection(token, bankConnectionId);
    patch.bankName = connection.bank?.name ?? l.state.bankName;
    const interfaces = connection.interfaces ?? [];
    const consent = interfaces.find((i) => i.aisConsent?.expiresAt)?.aisConsent?.expiresAt ?? null;
    if (interfaces.some((i) => i.userActionRequired)) patch.userActionRequired = true;
    await ctx.db
      .update(bankConnections)
      .set({ consentExpiresAt: consent ? new Date(consent) : null })
      .where(eq(bankConnections.id, connectionId));
    const accountId = 'accountId' in patch ? patch.accountId : l.state.accountId;
    if (!accountId) {
      const accounts = await l.api.listAccounts(token, bankConnectionId);
      const target = normalizeIban(l.account.iban);
      const match = accounts.find((a) => a.iban && normalizeIban(a.iban) === target);
      patch.accountId = match?.id ?? null;
      patch.accounts = accounts.map((a) => ({ id: a.id, iban: a.iban ?? null }));
    }
  }
  const next: FinApiState = { ...l.state, ...patch };
  await replaceConnectionState(
    ctx,
    connectionId,
    JSON.parse(JSON.stringify(next)) as Record<string, unknown>,
  );
  return next;
}

export function mapFinApiTransactions(
  rows: readonly FinApiTransaction[],
  fallbackCurrency: string,
): ParsedTransaction[] {
  const out: ParsedTransaction[] = [];
  for (const t of rows) {
    if (t.isAdjustingEntry) continue;
    const date = (t.bankBookingDate ?? t.finapiBookingDate ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(t.amount)) continue;
    const amount = Math.round(t.amount * 100);
    if (amount === 0) continue;
    const iban = (t.counterpartIban ?? '').replace(/\s/g, '').toUpperCase();
    const e2e = t.endToEndReference?.trim();
    out.push({
      bookingDate: date,
      valueDate: t.valueDate?.slice(0, 10) ?? null,
      amount,
      currency: (t.currency ?? fallbackCurrency).toUpperCase(),
      counterpartyName: cleanText(t.counterpartName, 140),
      counterpartyIban: /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) ? iban : null,
      counterpartyBic: cleanText(t.counterpartBic, 11),
      remittanceInformation: cleanText(t.purpose),
      endToEndId: e2e && e2e.toUpperCase() !== 'NOTPROVIDED' ? e2e.slice(0, 35) : null,
      externalId: String(t.id),
      bankTransactionCode: t.typeCodeZka ?? t.bankTransactionCode ?? null,
      bookingText: cleanText(t.type, 200),
      raw: Object.fromEntries(
        Object.entries({
          source: 'finapi',
          finapiId: t.id,
          potentialDuplicate: t.isPotentialDuplicate || undefined,
          account: t.counterpartAccountNumber ?? undefined,
        }).filter(([, v]) => v !== undefined && v !== null),
      ),
    });
  }
  return out;
}

export interface FinApiSyncResult {
  transactions: ParsedTransaction[];
  periodFrom: string;
  periodTo: string;
  /** Problem that did not prevent downloading stored data (e.g. consent renewal needed). */
  warning: BankSyncError | null;
}

export async function syncFinApi(
  ctx: CoreContext,
  params: { connectionId: string; lastSuccessfulSyncAt: Date | null },
  deps: FinApiDeps = {},
): Promise<FinApiSyncResult> {
  const state = await refreshFinApiConnection(ctx, params.connectionId, deps);
  const l = await load(ctx, params.connectionId, deps);
  if (!state.bankConnectionId) {
    throw new BankSyncError(
      'FINAPI_NOT_CONNECTED',
      'Connect the bank via the finAPI web form first',
    );
  }
  if (!state.accountId) {
    throw new BankSyncError(
      'FINAPI_ACCOUNT_NOT_FOUND',
      'The account IBAN is not part of the connected bank login',
    );
  }
  const { token } = await userToken(ctx, l);
  let warning: BankSyncError | null = null;

  if (l.config.backgroundUpdate) {
    try {
      const task = await pollTask(
        l.api,
        token,
        await l.api.startBackgroundUpdate(token, {
          bankConnectionId: state.bankConnectionId,
          importNewAccountsMode: 'SKIP',
          skipPositionsDownload: true,
          ...(l.config.webFormProfileId ? { profileId: l.config.webFormProfileId } : {}),
        }),
        deps,
      );
      if (task.payload?.webForm || task.status === 'WEB_FORM_REQUIRED') {
        if (task.payload?.webForm) {
          await patchConnectionState(ctx, l.connection.id, {
            webForm: webFormState(task.payload.webForm, 'UPDATE'),
            userActionRequired: true,
          });
        }
        warning = new BankSyncError(
          'FINAPI_USER_ACTION_REQUIRED',
          'The bank requires a new authentication – open the bank login in the connection settings',
        );
      } else if (task.status === 'COMPLETED_WITH_ERROR') {
        warning = new BankSyncError(
          'FINAPI_UPDATE_FAILED',
          task.payload?.errorMessage ?? task.payload?.errorCode ?? 'Bank update failed',
        );
      } else if (task.status !== 'COMPLETED') {
        warning = new BankSyncError('FINAPI_UPDATE_TIMEOUT', 'The bank update is still running');
      }
    } catch (err) {
      // 423 = an update is already running (e.g. finAPI batch update) – download what is there.
      if (!(err instanceof FinApiError && err.status === 423)) throw err;
    }
  }

  const today = todayIso();
  let from = addDaysIso(today, -l.config.lookbackDays);
  if (params.lastSuccessfulSyncAt) {
    const since = addDaysIso(todayIso('Europe/Berlin', params.lastSuccessfulSyncAt), -7);
    if (since > from) from = since;
  }
  const rows = await l.api.listTransactions(token, {
    accountId: state.accountId,
    minBankBookingDate: from,
  });
  return {
    transactions: mapFinApiTransactions(rows, l.account.currency),
    periodFrom: from,
    periodTo: today,
    warning,
  };
}

/** Deletes the finAPI user (and with it the bank connection and the consent at the bank). */
export async function disconnectFinApi(
  ctx: CoreContext,
  connection: Pick<BankConnectionRow, 'id' | 'config' | 'state' | 'credentialsEncrypted'>,
  deps: FinApiDeps = {},
): Promise<void> {
  const state = parseState(connection.state);
  const secrets = decryptConnectionSecrets(ctx, connection, 'PSD2_FINAPI');
  if (!state.userId || !secrets?.userPassword) return;
  const config = finApiConfigSchema.parse(connection.config);
  const api = client(config, secrets, deps);
  try {
    const token = await api.userToken(state.userId, secrets.userPassword);
    await api.deleteUser(token);
  } catch (err) {
    // Already gone (deleted user / revoked client) – nothing left to clean up.
    if (!(err instanceof FinApiError && [400, 401, 404].includes(err.status))) throw err;
  } finally {
    api.forgetUserToken(state.userId);
  }
}
