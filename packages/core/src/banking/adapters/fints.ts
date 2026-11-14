import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  finTsConfigSchema,
  finTsStateSchema,
  germanAccountFromIban,
  normalizeIban,
  type FinTsConfig,
  type FinTsState,
} from '@tix/shared';
import {
  FinTSClient,
  FinTSConfig,
  type AccountRef,
  type BankAccount,
  type BankAnswer,
  type BankingInformation,
  type ClientResponse,
  type Statement,
  type StatementResponse,
  type SynchronizeResponse,
} from 'lib-fints';
import type { CoreContext } from '../../context';
import { assertBankEndpointAllowed } from '../../network/host-guard';
import {
  BankSyncError,
  replaceConnectionState,
  type BankAccountRow,
  type BankConnectionRow,
} from '../connections';
import { addDaysIso, cleanText, todayIso } from '../text';
import { closeTanChallenge, openTanChallenge, takeTanResponse } from '../tan';
import type { ParsedTransaction } from '../types';

/**
 * FinTS 3.0 PIN/TAN adapter (lib-fints). Flow per sync:
 *  1. restore banking information (BPD/UPD, system id) from `state` or synchronise,
 *  2. select the configured TAN procedure (+ medium) – synchronise again for the UPD,
 *  3. find the receiving account by IBAN, fetch statements (CAMT preferred, MT940 fallback),
 *  4. any TAN request → challenge in the Admin Portal, the dialog stays open meanwhile.
 * Setup problems (no TAN procedure chosen, account missing) are reported as BankSyncError
 * codes and written to `state.setupIssue` so the Admin Portal can guide the admin.
 */

/** TanMediaRequirement.Required in lib-fints. */
const TAN_MEDIA_REQUIRED = 2;
const DEFAULT_TAN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DECOUPLED_TIMEOUT_MS = 15 * 60 * 1000;
const RESPONSE_POLL_MS = 1000;

/** Subset of FinTSClient used here (lets tests inject a scripted client). */
export interface FinTsClientPort {
  readonly config: {
    bankingInformation: BankingInformation;
    readonly availableTanMethods: FinTSConfig['availableTanMethods'];
    readonly selectedTanMethod: FinTSConfig['selectedTanMethod'];
  };
  selectTanMethod(id: number): unknown;
  selectTanMedia(name: string): void;
  synchronize(): Promise<SynchronizeResponse>;
  synchronizeWithTan(reference: string, tan?: string): Promise<SynchronizeResponse>;
  canGetAccountStatements(account?: AccountRef): boolean;
  getAccountStatements(
    account: AccountRef,
    from?: Date,
    to?: Date,
    preferCamt?: boolean,
  ): Promise<StatementResponse>;
  getAccountStatementsWithTan(reference: string, tan?: string): Promise<StatementResponse>;
}

export type FinTsClientFactory = (params: {
  config: FinTsConfig;
  pin: string;
  bankingInformation: BankingInformation | null;
}) => FinTsClientPort;

export const createFinTsClient: FinTsClientFactory = ({ config, pin, bankingInformation }) => {
  const bpd = bankingInformation?.bpd;
  const fintsConfig =
    bankingInformation && bpd
      ? FinTSConfig.fromBankingInformation(
          config.productId,
          config.productVersion,
          // The bank's parameter data may omit the URL – fall back to the configured one.
          { ...bankingInformation, bpd: { ...bpd, url: bpd.url || config.serverUrl } },
          config.userId,
          pin,
          undefined,
          undefined,
          config.customerId || undefined,
        )
      : FinTSConfig.forFirstTimeUse(
          config.productId,
          config.productVersion,
          config.serverUrl,
          config.bankCode,
          config.userId,
          pin,
          config.customerId || undefined,
        );
  return new FinTSClient(fintsConfig);
};

export interface FinTsSyncParams {
  connection: Pick<BankConnectionRow, 'id' | 'config' | 'state'>;
  account: Pick<BankAccountRow, 'iban' | 'currency'>;
  syncRunId: string;
  pin: string;
  /** Last successful sync – limits the requested period (PSD2: fewer TAN prompts). */
  lastSuccessfulSyncAt: Date | null;
  clientFactory?: FinTsClientFactory;
  tanTimeoutMs?: number;
  /** Override for tests. */
  pollIntervalMs?: number;
}

export interface FinTsSyncResult {
  transactions: ParsedTransaction[];
  periodFrom: string;
  periodTo: string;
}

/** Identity of the bank login; banking information is discarded when it changes. */
export function finTsIdentity(config: FinTsConfig): string {
  return createHash('sha256')
    .update([config.serverUrl, config.bankCode, config.userId, config.customerId ?? ''].join('|'))
    .digest('hex')
    .slice(0, 32);
}

export function describeBankAnswers(answers: readonly BankAnswer[]): string {
  const relevant = answers.filter((a) => a.code >= 9000);
  return (relevant.length > 0 ? relevant : answers)
    .map((a) => `${a.code} ${a.text}`.trim())
    .join('; ')
    .slice(0, 1000);
}

function localIsoDate(date: Date | string | undefined): string | null {
  if (!date) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const IBAN_LIKE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const BIC_LIKE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** Maps lib-fints statements (CAMT or MT940) to the common transaction shape. */
export function mapFinTsStatements(
  statements: readonly Statement[],
  fallbackCurrency: string,
): ParsedTransaction[] {
  const out: ParsedTransaction[] = [];
  for (const statement of statements) {
    const currency =
      statement.closingBalance?.currency || statement.openingBalance?.currency || fallbackCurrency;
    for (const t of statement.transactions ?? []) {
      const bookingDate = localIsoDate(t.entryDate) ?? localIsoDate(t.valueDate);
      if (!bookingDate || typeof t.amount !== 'number' || !Number.isFinite(t.amount)) continue;
      const amount = Math.round(t.amount * 100);
      if (amount === 0) continue;
      const account = (t.remoteAccountNumber ?? '').replace(/\s/g, '').toUpperCase();
      const bic = (t.remoteBankId ?? '').replace(/\s/g, '').toUpperCase();
      const e2e = t.e2eReference?.trim();
      out.push({
        bookingDate,
        valueDate: localIsoDate(t.valueDate),
        amount,
        currency: currency.toUpperCase(),
        counterpartyName: cleanText(t.remoteName, 140),
        counterpartyIban: IBAN_LIKE.test(account) ? account : null,
        counterpartyBic: BIC_LIKE.test(bic) ? bic : null,
        remittanceInformation: cleanText(t.purpose),
        endToEndId: e2e && e2e.toUpperCase() !== 'NOTPROVIDED' ? e2e.slice(0, 35) : null,
        externalId: t.bankReference?.trim() || null,
        bankTransactionCode: t.transactionCode?.trim() || t.transactionType?.trim() || null,
        bookingText: cleanText(t.bookingText, 200),
        raw: Object.fromEntries(
          Object.entries({
            source: 'fints',
            customerReference: t.customerReference,
            mandateReference: t.mandateReference,
            account: IBAN_LIKE.test(account) ? undefined : account || undefined,
            additionalInformation: t.additionalInformation,
          }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
        ),
      });
    }
  }
  return out;
}

function findAccount(accounts: readonly BankAccount[], iban: string): BankAccount | undefined {
  const target = normalizeIban(iban);
  const byIban = accounts.find((a) => a.iban && normalizeIban(a.iban) === target);
  if (byIban) return byIban;
  const de = germanAccountFromIban(target);
  if (!de) return undefined;
  return accounts.find(
    (a) =>
      a.bank?.bankId === de.bankCode &&
      a.accountNumber.replace(/^0+/, '') === de.accountNumber.replace(/^0+/, ''),
  );
}

export async function syncFinTs(
  ctx: CoreContext,
  params: FinTsSyncParams,
): Promise<FinTsSyncResult> {
  const config = finTsConfigSchema.parse(params.connection.config);
  const identity = finTsIdentity(config);
  const parsedState = finTsStateSchema.safeParse(params.connection.state ?? {});
  let state: FinTsState =
    parsedState.success && parsedState.data.identity === identity
      ? parsedState.data
      : finTsStateSchema.parse({ identity });

  // SSRF guard right before connecting (also covers DNS changes after the settings were saved):
  // the configured URL and the URL announced in the bank's parameter data must be public https.
  await assertBankEndpointAllowed(config.serverUrl);
  const announcedUrl = (state.bankingInformation as BankingInformation | undefined)?.bpd?.url;
  if (announcedUrl) await assertBankEndpointAllowed(announcedUrl);

  const client = (params.clientFactory ?? createFinTsClient)({
    config,
    pin: params.pin,
    bankingInformation: (state.bankingInformation as BankingInformation | undefined) ?? null,
  });

  const persist = async (patch: Partial<FinTsState> = {}) => {
    const info = client.config.bankingInformation;
    state = {
      ...state,
      ...patch,
      identity,
      bankingInformation: JSON.parse(JSON.stringify(info)) as unknown,
      bankName: info.bpd?.bankName ?? state.bankName,
      tanMethods: client.config.availableTanMethods.map((m) => ({
        id: m.id,
        name: m.name,
        isDecoupled: m.isDecoupled,
        activeTanMedia: m.activeTanMedia ?? [],
        tanMediumRequired: m.tanMediaRequirement === TAN_MEDIA_REQUIRED,
      })),
      accounts: (info.upd?.bankAccounts ?? []).map((a) => ({
        iban: a.iban,
        accountNumber: a.accountNumber,
        currency: a.currency,
        product: a.product,
        holder: a.holder1,
      })),
      bankMessages: (info.bankMessages ?? []).slice(-10),
    };
    await replaceConnectionState(ctx, params.connection.id, state as Record<string, unknown>);
  };

  const fail = async (code: string, message: string, setupIssue?: FinTsState['setupIssue']) => {
    await persist(setupIssue !== undefined ? { setupIssue } : {});
    return new BankSyncError(code, message);
  };

  const checked = async <T extends ClientResponse>(response: T): Promise<T> => {
    if (!response.success) {
      throw await fail(
        'FINTS_BANK_ERROR',
        describeBankAnswers(response.bankAnswers) || 'The bank rejected the request',
      );
    }
    return response;
  };

  const resolveTan = <T extends ClientResponse>(
    first: T,
    continueWith: (reference: string, tan?: string) => Promise<T>,
  ) =>
    handleTan(ctx, {
      client,
      first,
      continueWith,
      connectionId: params.connection.id,
      syncRunId: params.syncRunId,
      tanTimeoutMs: params.tanTimeoutMs ?? DEFAULT_TAN_TIMEOUT_MS,
      pollIntervalMs: params.pollIntervalMs ?? RESPONSE_POLL_MS,
    });

  // 1. Bank parameter data (TAN procedures).
  if (!client.config.bankingInformation.bpd) {
    const first = await client.synchronize();
    await checked(await resolveTan(first, (r, t) => client.synchronizeWithTan(r, t)));
    await persist();
  }

  // 2. TAN procedure (+ medium).
  const methods = client.config.availableTanMethods;
  const methodId = config.tanMethodId ?? (methods.length === 1 ? methods[0]!.id : undefined);
  if (!methodId || !methods.some((m) => m.id === methodId)) {
    throw await fail(
      'FINTS_TAN_METHOD_REQUIRED',
      'Select the TAN procedure for this connection',
      'TAN_METHOD_REQUIRED',
    );
  }
  client.selectTanMethod(methodId);
  if (config.tanMediumName) client.selectTanMedia(config.tanMediumName);

  // 3. User parameter data (accounts) – needs a dialog with the chosen TAN procedure.
  if (!client.config.bankingInformation.upd?.bankAccounts?.length) {
    const first = await client.synchronize();
    await checked(await resolveTan(first, (r, t) => client.synchronizeWithTan(r, t)));
    await persist();
  }
  const method = client.config.selectedTanMethod;
  if (method && method.tanMediaRequirement === TAN_MEDIA_REQUIRED && !config.tanMediumName) {
    const media = method.activeTanMedia ?? [];
    if (media.length !== 1) {
      throw await fail(
        'FINTS_TAN_MEDIUM_REQUIRED',
        'Select the TAN medium (device) for this connection',
        'TAN_MEDIUM_REQUIRED',
      );
    }
    client.selectTanMedia(media[0]!);
  }

  // 4. Receiving account.
  const account = findAccount(
    client.config.bankingInformation.upd?.bankAccounts ?? [],
    params.account.iban,
  );
  if (!account) {
    throw await fail(
      'FINTS_ACCOUNT_NOT_FOUND',
      'The account IBAN is not among the accounts of this online-banking login',
      'ACCOUNT_NOT_FOUND',
    );
  }
  if (!client.canGetAccountStatements(account)) {
    throw await fail(
      'FINTS_STATEMENTS_NOT_SUPPORTED',
      'The bank does not offer statement downloads for this account via FinTS',
      'STATEMENTS_NOT_SUPPORTED',
    );
  }

  // 5. Statements.
  const today = todayIso();
  let from = addDaysIso(today, -config.lookbackDays);
  if (params.lastSuccessfulSyncAt) {
    const since = addDaysIso(todayIso('Europe/Berlin', params.lastSuccessfulSyncAt), -7);
    if (since > from) from = since;
  }
  const first = await client.getAccountStatements(
    account,
    new Date(`${from}T00:00:00`),
    new Date(`${today}T00:00:00`),
    config.preferCamt,
  );
  const response = await checked(
    await resolveTan(first, (r, t) => client.getAccountStatementsWithTan(r, t)),
  );
  if (!Array.isArray((response as Partial<StatementResponse>).statements)) {
    throw await fail('FINTS_NO_STATEMENTS', 'The bank answered without statement data');
  }
  await persist({ setupIssue: null });
  return {
    transactions: mapFinTsStatements(response.statements, params.account.currency),
    periodFrom: from,
    periodTo: today,
  };
}

interface HandleTanParams<T extends ClientResponse> {
  client: FinTsClientPort;
  first: T;
  continueWith: (reference: string, tan?: string) => Promise<T>;
  connectionId: string;
  syncRunId: string;
  tanTimeoutMs: number;
  pollIntervalMs: number;
}

/** Resolves (repeated) TAN requests of one business transaction via the Admin Portal. */
async function handleTan<T extends ClientResponse>(
  ctx: CoreContext,
  p: HandleTanParams<T>,
): Promise<T> {
  let response = p.first;
  for (let round = 0; response.requiresTan; round += 1) {
    if (round >= 3) throw new BankSyncError('FINTS_TAN_LOOP', 'The bank kept requesting TANs');
    if (!response.success) return response;
    const reference = response.tanReference;
    if (!reference) throw new BankSyncError('FINTS_TAN_REFERENCE', 'TAN request without reference');
    const method = p.client.config.selectedTanMethod;
    const decoupled = method?.isDecoupled ?? false;
    const params = method?.decoupled;
    const decoupledTimeout = params
      ? (params.waitingSecondsBeforeFirstStatusRequest +
          params.maxStatusRequests * Math.max(1, params.waitingSecondsBetweenStatusRequests)) *
        1000
      : p.tanTimeoutMs;
    const timeoutMs = decoupled
      ? Math.min(MAX_DECOUPLED_TIMEOUT_MS, Math.max(p.tanTimeoutMs, decoupledTimeout))
      : p.tanTimeoutMs;
    const challenge = await openTanChallenge(ctx, {
      connectionId: p.connectionId,
      syncRunId: p.syncRunId,
      tanMethod: method?.name ?? null,
      challengeText: response.tanChallenge ?? null,
      media: response.tanPhoto
        ? { mimeType: response.tanPhoto.mimeType, data: response.tanPhoto.image }
        : null,
      isDecoupled: decoupled,
      timeoutMs,
    });
    const close = (status: 'COMPLETED' | 'EXPIRED' | 'FAILED') =>
      closeTanChallenge(ctx, {
        challengeId: challenge.id,
        syncRunId: p.syncRunId,
        connectionId: p.connectionId,
        status,
      });
    try {
      response = decoupled
        ? await awaitDecoupled(ctx, p, challenge, reference)
        : await awaitTan(ctx, p, challenge, reference);
    } catch (err) {
      await close(
        err instanceof BankSyncError && err.code === 'TAN_EXPIRED' ? 'EXPIRED' : 'FAILED',
      );
      throw err;
    }
    await close(response.success ? 'COMPLETED' : 'FAILED');
  }
  return response;
}

async function awaitTan<T extends ClientResponse>(
  ctx: CoreContext,
  p: HandleTanParams<T>,
  challenge: { id: string; expiresAt: Date },
  reference: string,
): Promise<T> {
  while (Date.now() < challenge.expiresAt.getTime()) {
    const answer = await takeTanResponse(ctx, challenge.id);
    if (answer?.kind === 'CANCELLED')
      throw new BankSyncError('TAN_CANCELLED', 'TAN entry cancelled');
    if (answer?.kind === 'TAN') return p.continueWith(reference, answer.tan);
    await sleep(p.pollIntervalMs);
  }
  throw new BankSyncError('TAN_EXPIRED', 'No TAN was entered in time');
}

/**
 * Decoupled (app approval): status requests to the bank – automatically at the intervals
 * from the bank parameters, or right after the admin confirmed the approval.
 */
async function awaitDecoupled<T extends ClientResponse>(
  ctx: CoreContext,
  p: HandleTanParams<T>,
  challenge: { id: string; expiresAt: Date },
  reference: string,
): Promise<T> {
  const params = p.client.config.selectedTanMethod?.decoupled;
  const auto = params?.autoConfirmationAllowed ?? true;
  const between = Math.max(2, params?.waitingSecondsBetweenStatusRequests ?? 5) * 1000;
  let nextPoll =
    Date.now() + Math.max(1, params?.waitingSecondsBeforeFirstStatusRequest ?? 5) * 1000;
  let polls = 0;
  let currentReference = reference;
  while (Date.now() < challenge.expiresAt.getTime()) {
    const answer = await takeTanResponse(ctx, challenge.id);
    if (answer?.kind === 'CANCELLED')
      throw new BankSyncError('TAN_CANCELLED', 'Approval cancelled');
    const confirmed = answer !== null;
    const maxReached = params?.maxStatusRequests ? polls >= params.maxStatusRequests : false;
    if (confirmed || (auto && !maxReached && Date.now() >= nextPoll)) {
      polls += 1;
      const response = await p.continueWith(currentReference);
      if (!response.requiresTan || !response.success) return response;
      currentReference = response.tanReference ?? currentReference;
      nextPoll = Date.now() + between;
    }
    await sleep(p.pollIntervalMs);
  }
  throw new BankSyncError('TAN_EXPIRED', 'The approval was not given in time');
}
