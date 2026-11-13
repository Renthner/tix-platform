'use server';

import {
  BankSyncError,
  DomainError,
  FinApiError,
  assignBankTransaction,
  deleteBankAccount,
  deleteBankConnection,
  decryptConnectionSecrets,
  ignoreBankTransaction,
  loadConnection,
  refreshFinApiConnection,
  rematchBankTransaction,
  requestBankSync,
  resolveBankTransaction,
  reverseBankAllocation,
  respondToTanChallenge,
  saveBankAccount,
  saveBankConnection,
  searchOrders,
  startFinApiWebForm,
  testImapConnection,
} from '@tix/core';
import { bankTransactions } from '@tix/db';
import {
  BANK_STATEMENT_FORMATS,
  CSV_COLUMN_KEYS,
  imapConfigSchema,
  localizedPath,
  type SupportedBankAdapter,
} from '@tix/shared';
import { eq } from 'drizzle-orm';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import {
  BANKING_FIELD_ERRORS,
  type BankingActionState,
  type BankingFieldError,
  type BankingFormError,
  type BankingMessage,
} from '@/lib/banking-action-state';
import { parseMoneyToCents } from '@/lib/money';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { getDefaultLocale } from '@/server/default-locale';
import { audit } from './audit';
import { flag, text } from './form';

const ROLES = ['FINANCE'] as const;

const ok = (
  message: BankingMessage,
  extra: { values?: Record<string, number | string>; url?: string } = {},
): BankingActionState => ({ status: 'success', message, ...extra, at: Date.now() });

const formError = (code: BankingFormError, detail?: string): BankingActionState => ({
  status: 'error',
  formError: code,
  ...(detail ? { detail } : {}),
  at: Date.now(),
});

const fieldErrors = (
  errors: Partial<Record<string, BankingFieldError>>,
  values?: Record<string, number | string>,
): BankingActionState => ({ status: 'error', fieldErrors: errors, values, at: Date.now() });

function zodErrors(error: z.ZodError): Partial<Record<string, BankingFieldError>> {
  const out: Partial<Record<string, BankingFieldError>> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (out[key]) continue;
    if ((BANKING_FIELD_ERRORS as readonly string[]).includes(issue.message)) {
      out[key] = issue.message as BankingFieldError;
    } else if (issue.code === 'too_small') {
      out[key] = issue.origin === 'string' && issue.minimum === 1 ? 'required' : 'tooSmall';
    } else if (issue.code === 'too_big') {
      out[key] = issue.origin === 'string' ? 'tooLong' : 'tooLarge';
    } else if (issue.code === 'invalid_type' && issue.input === undefined) {
      out[key] = 'required';
    } else if (issue.code === 'invalid_format' && issue.format === 'url') {
      out[key] = 'url';
    } else {
      out[key] = 'invalid';
    }
  }
  return out;
}

const DOMAIN_TO_FORM: Record<string, BankingFormError> = {
  NOT_FOUND: 'notFound',
  TX_NOT_FOUND: 'notFound',
  BUSY: 'busy',
  INACTIVE: 'inactive',
  NOT_POLLING: 'notPolling',
  HAS_TRANSACTIONS: 'hasTransactions',
  TAN_NOT_PENDING: 'tanNotPending',
  TAN_NOT_FOUND: 'tanNotPending',
  ORDER_NOT_PAYABLE: 'orderNotPayable',
  ORDER_NOT_FOUND: 'orderNotFound',
  CURRENCY_MISMATCH: 'currencyMismatch',
  TX_RESOLVED: 'resolved',
  TX_NOT_FULLY_ASSIGNED: 'notFullyAssigned',
  TX_HAS_ALLOCATIONS: 'hasAllocations',
  TX_NOT_CREDIT: 'notCredit',
  NOT_SUPPORTED: 'notSupported',
  ADAPTER_CHANGE: 'notSupported',
  NO_QUEUE: 'generic',
  ALLOCATION_NOT_FOUND: 'notFound',
  ALLOCATION_ALREADY_REVERSED: 'alreadyReversed',
  REVERSAL_BLOCKED_REFUNDS: 'reversalBlockedRefunds',
  REVERSAL_BLOCKED_CHECKED_IN: 'reversalBlockedCheckedIn',
  REVERSAL_BLOCKED_STATE: 'reversalBlockedState',
  REVERSAL_BLOCKED_PAYPAL_ORDER: 'reversalBlockedPaypalOrder',
  REVERSAL_BLOCKED_EVENT_STARTED: 'reversalBlockedEventStarted',
  REVERSAL_BLOCKED_ADJUSTMENT: 'reversalBlockedAdjustment',
  ADJUSTMENT_NOT_PAYABLE: 'orderNotPayable',
  ADJUSTMENT_NOT_FOUND: 'orderNotFound',
  ADJUSTMENT_AMOUNT_MISMATCH: 'adjustmentAmount',
};

/** Maps domain / provider errors to an action state (unexpected errors are rethrown). */
function failure(err: unknown): BankingActionState {
  if (err instanceof z.ZodError) return fieldErrors(zodErrors(err));
  if (err instanceof DomainError) {
    switch (err.code) {
      case 'IBAN_TAKEN':
        return fieldErrors({ iban: 'ibanTaken' });
      case 'POLL_INTERVAL':
        return fieldErrors(
          { pollIntervalMinutes: 'pollInterval' },
          { minutes: Math.ceil(Number(err.details?.min ?? 60) / 60) },
        );
      case 'SECRET_REQUIRED':
        return fieldErrors({ [`secret.${String(err.details?.field ?? '')}`]: 'required' });
      case 'NAME_REQUIRED':
        return fieldErrors({ name: 'required' });
      case 'HOST_NOT_ALLOWED':
        return fieldErrors({ [String(err.details?.field ?? 'host')]: 'hostNotAllowed' });
      case 'TAN_INVALID':
        return fieldErrors({ tan: 'tan' });
      case 'AMOUNT_EXCEEDS':
        return fieldErrors({ amount: 'amount' });
      case 'REASON_REQUIRED':
        return fieldErrors({ reason: 'required' });
      default:
        return formError(DOMAIN_TO_FORM[err.code] ?? 'generic', err.message);
    }
  }
  if (err instanceof FinApiError) return formError('provider', `${err.code}: ${err.message}`);
  if (err instanceof BankSyncError) return formError('provider', `${err.code}: ${err.message}`);
  throw err;
}

const revalidate = () => revalidatePath('/', 'layout');

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function saveBankAccountAction(
  accountId: string | null,
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  let id: string;
  try {
    ({ id } = await saveBankAccount(core, accountId, {
      name: text(fd, 'name') ?? '',
      accountHolder: text(fd, 'accountHolder') ?? '',
      iban: text(fd, 'iban') ?? '',
      bic: text(fd, 'bic') ?? '',
      bankName: text(fd, 'bankName'),
      currency: (text(fd, 'currency') ?? 'EUR').toUpperCase(),
      isDefaultForBankTransfer: flag(fd, 'isDefaultForBankTransfer'),
      isActive: flag(fd, 'isActive'),
    }));
  } catch (err) {
    return failure(err);
  }
  await audit(
    core.db,
    session,
    accountId ? 'bank.account.update' : 'bank.account.create',
    'bank_account',
    id,
    {
      name: text(fd, 'name'),
    },
  );
  revalidate();
  if (!accountId) redirect({ href: `/admin/banking/accounts/${id}`, locale: await getLocale() });
  return ok('saved');
}

export async function deleteBankAccountAction(
  accountId: string,
  _prev: BankingActionState,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  try {
    await deleteBankAccount(core, accountId);
  } catch (err) {
    return failure(err);
  }
  await audit(core.db, session, 'bank.account.delete', 'bank_account', accountId);
  revalidate();
  redirect({ href: '/admin/banking/accounts', locale: await getLocale() });
  return ok('deleted');
}

// ─── Connections ─────────────────────────────────────────────────────────────

const num = (fd: FormData, name: string): number | undefined => {
  const v = text(fd, name);
  return v === undefined ? undefined : Number(v);
};

function csvProfileFrom(fd: FormData) {
  const columns: Record<string, string> = {};
  for (const key of CSV_COLUMN_KEYS) {
    const v = text(fd, `csvProfile.columns.${key}`);
    if (v) columns[key] = v;
  }
  const headerRow = num(fd, 'csvProfile.headerRow');
  return {
    delimiter:
      text(fd, 'csvProfile.delimiter') === 'tab'
        ? '\t'
        : (text(fd, 'csvProfile.delimiter') ?? 'auto'),
    encoding: text(fd, 'csvProfile.encoding') ?? 'auto',
    headerRow: headerRow ?? null,
    dateFormat: text(fd, 'csvProfile.dateFormat') ?? 'auto',
    decimalSeparator: text(fd, 'csvProfile.decimalSeparator') ?? 'auto',
    columns,
  };
}

function configFrom(adapter: SupportedBankAdapter, fd: FormData): Record<string, unknown> {
  const lookbackDays = num(fd, 'lookbackDays');
  switch (adapter) {
    case 'FINTS':
      return {
        adapter,
        serverUrl: text(fd, 'serverUrl'),
        bankCode: text(fd, 'bankCode')?.replace(/\s/g, ''),
        userId: text(fd, 'userId'),
        customerId: text(fd, 'customerId'),
        productId: text(fd, 'productId'),
        productVersion: text(fd, 'productVersion') ?? '1.0',
        tanMethodId: num(fd, 'tanMethodId'),
        tanMediumName: text(fd, 'tanMediumName'),
        preferCamt: flag(fd, 'preferCamt'),
        ...(lookbackDays !== undefined ? { lookbackDays } : {}),
      };
    case 'PSD2_FINAPI':
      return {
        adapter,
        environment: text(fd, 'environment'),
        clientId: text(fd, 'clientId'),
        webFormProfileId: text(fd, 'webFormProfileId'),
        backgroundUpdate: flag(fd, 'backgroundUpdate'),
        ...(lookbackDays !== undefined ? { lookbackDays } : {}),
      };
    case 'FILE_IMPORT':
      return {
        adapter,
        formatHint: text(fd, 'formatHint') ?? 'AUTO',
        csvProfile: csvProfileFrom(fd),
      };
    case 'IMAP':
      return {
        adapter,
        host: text(fd, 'host'),
        port: num(fd, 'port'),
        secure: flag(fd, 'secure'),
        username: text(fd, 'username'),
        mailbox: text(fd, 'mailbox') ?? 'INBOX',
        processedMailbox: text(fd, 'processedMailbox'),
        senderAllowlist: (text(fd, 'senderAllowlist') ?? '')
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        subjectFilter: text(fd, 'subjectFilter'),
        attachmentFormats: BANK_STATEMENT_FORMATS.filter((f) => flag(fd, `attachmentFormats.${f}`)),
        lookbackDays: num(fd, 'lookbackDays'),
        csvProfile: csvProfileFrom(fd),
      };
  }
}

const SECRET_FIELDS: Record<SupportedBankAdapter, string[]> = {
  FINTS: ['pin'],
  PSD2_FINAPI: ['clientSecret'],
  IMAP: ['password'],
  FILE_IMPORT: [],
};

export async function saveBankConnectionAction(
  accountId: string,
  connectionId: string | null,
  adapter: SupportedBankAdapter,
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const minutes = num(fd, 'pollIntervalMinutes');
  if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) {
    return fieldErrors({ pollIntervalMinutes: 'invalid' });
  }
  const secrets: Record<string, string | undefined> = {};
  for (const field of SECRET_FIELDS[adapter]) {
    const value = fd.get(`secret.${field}`);
    secrets[field] = typeof value === 'string' && value !== '' ? value : undefined;
  }
  let id: string;
  try {
    ({ id } = await saveBankConnection(core, connectionId, {
      bankAccountId: accountId,
      name: text(fd, 'name') ?? '',
      isActive: flag(fd, 'isActive'),
      pollIntervalSeconds: minutes === undefined ? null : Math.round(minutes * 60),
      config: configFrom(adapter, fd),
      secrets,
    }));
  } catch (err) {
    return failure(err);
  }
  // Secrets are never written to the audit log.
  await audit(
    core.db,
    session,
    connectionId ? 'bank.connection.update' : 'bank.connection.create',
    'bank_connection',
    id,
    { adapter, name: text(fd, 'name'), secretsChanged: Object.values(secrets).some(Boolean) },
  );
  revalidate();
  if (!connectionId)
    redirect({ href: `/admin/banking/connections/${id}`, locale: await getLocale() });
  return ok('saved');
}

export async function deleteBankConnectionAction(
  connectionId: string,
  accountId: string,
  _prev: BankingActionState,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  try {
    await deleteBankConnection(core, connectionId);
  } catch (err) {
    return failure(err);
  }
  await audit(core.db, session, 'bank.connection.delete', 'bank_connection', connectionId);
  revalidate();
  redirect({ href: `/admin/banking/accounts/${accountId}`, locale: await getLocale() });
  return ok('deleted');
}

export async function syncBankConnectionAction(
  connectionId: string,
  _prev: BankingActionState,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  try {
    await requestBankSync(core, { connectionId, userId: session.userId });
  } catch (err) {
    return failure(err);
  }
  await audit(core.db, session, 'bank.sync.request', 'bank_connection', connectionId);
  revalidate();
  return ok('syncQueued');
}

export async function respondTanAction(
  challengeId: string,
  kind: 'TAN' | 'DECOUPLED_CONFIRMED' | 'CANCELLED',
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const tan = typeof fd.get('tan') === 'string' ? String(fd.get('tan')) : '';
  if (kind === 'TAN' && tan.trim() === '') return fieldErrors({ tan: 'required' });
  try {
    await respondToTanChallenge(core, {
      challengeId,
      userId: session.userId,
      response: kind === 'TAN' ? { kind, tan } : { kind },
    });
  } catch (err) {
    return failure(err);
  }
  // The TAN itself is never logged.
  await audit(core.db, session, 'bank.tan.respond', 'bank_tan_challenge', challengeId, { kind });
  revalidate();
  return ok(kind === 'TAN' ? 'tanSent' : kind === 'CANCELLED' ? 'tanCancelled' : 'approvalSent');
}

export async function finApiConnectAction(
  connectionId: string,
  _prev: BankingActionState,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const locale = await getLocale();
  try {
    const result = await startFinApiWebForm(core, {
      connectionId,
      language: locale,
      returnUrl: core.appUrl
        ? `${core.appUrl}${localizedPath(locale, `/admin/banking/connections/${connectionId}`, await getDefaultLocale())}`
        : null,
    });
    await audit(core.db, session, 'bank.finapi.webform', 'bank_connection', connectionId, {
      status: result.status,
    });
    revalidate();
    return result.status === 'WEB_FORM' ? ok('webFormReady', { url: result.url }) : ok('upToDate');
  } catch (err) {
    return failure(err);
  }
}

export async function finApiRefreshAction(
  connectionId: string,
  _prev: BankingActionState,
): Promise<BankingActionState> {
  await requireAdmin(ROLES);
  try {
    await refreshFinApiConnection(getCore(), connectionId);
  } catch (err) {
    return failure(err);
  }
  revalidate();
  return ok('refreshed');
}

export async function testImapAction(
  connectionId: string,
  _prev: BankingActionState,
): Promise<BankingActionState> {
  await requireAdmin(ROLES);
  const core = getCore();
  const loaded = await loadConnection(core, connectionId);
  if (!loaded || loaded.connection.adapter !== 'IMAP') return formError('notFound');
  const secrets = decryptConnectionSecrets(core, loaded.connection, 'IMAP');
  if (!secrets) return formError('noCredentials');
  try {
    const result = await testImapConnection(
      imapConfigSchema.parse(loaded.connection.config),
      secrets.password,
    );
    return ok('imapOk', { values: { messages: result.messages } });
  } catch (err) {
    if (err instanceof DomainError || err instanceof BankSyncError) return failure(err);
    return formError('imap', (err as Error).message);
  }
}

// ─── Klärfälle ───────────────────────────────────────────────────────────────

export async function assignTransactionAction(
  transactionId: string,
  orderId: string,
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const rawAmount = text(fd, 'amount');
  const amount = rawAmount ? parseMoneyToCents(rawAmount) : undefined;
  if (amount === null) return fieldErrors({ amount: 'amount' });
  const note = text(fd, 'note')?.slice(0, 1000) ?? null;
  try {
    const result = await assignBankTransaction(core, {
      transactionId,
      orderId,
      amount,
      userId: session.userId,
      note,
    });
    const [tx] = await core.db
      .select({ currency: bankTransactions.currency })
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionId));
    await audit(core.db, session, 'bank.tx.assign', 'bank_transaction', transactionId, {
      orderId,
      amount: amount ?? 'remaining',
      result: result.payment,
      note,
    });
    revalidate();
    const values = {
      outstanding: result.outstanding,
      overpayment: result.overpayment,
      unassigned: result.unassigned,
      currency: tx?.currency ?? 'EUR',
    };
    const message: BankingMessage =
      result.payment === 'PARTIAL'
        ? 'assignedPartial'
        : result.overpayment > 0
          ? 'assignedOverpaid'
          : result.payment === 'ALREADY_PAID'
            ? 'assignedAlreadyPaid'
            : 'assignedPaid';
    return ok(message, { values });
  } catch (err) {
    return failure(err);
  }
}

/** Assigns (the exact amount of) a transfer to the open additional payment of an order. */
export async function assignAdjustmentAction(
  transactionId: string,
  orderId: string,
  adjustmentId: string,
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const note = text(fd, 'note')?.slice(0, 1000) ?? null;
  try {
    const result = await assignBankTransaction(core, {
      transactionId,
      orderId,
      adjustmentId,
      userId: session.userId,
      note,
    });
    await audit(core.db, session, 'bank.tx.assign_adjustment', 'bank_transaction', transactionId, {
      orderId,
      adjustmentId,
      note,
    });
    revalidate();
    const [tx] = await core.db
      .select({ currency: bankTransactions.currency })
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionId));
    return ok('assignedPaid', {
      values: {
        outstanding: 0,
        overpayment: 0,
        unassigned: result.unassigned,
        currency: tx?.currency ?? 'EUR',
      },
    });
  } catch (err) {
    return failure(err);
  }
}

export async function ignoreTransactionAction(
  transactionId: string,
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const note = text(fd, 'note');
  if (!note) return fieldErrors({ note: 'required' });
  try {
    await ignoreBankTransaction(core, { transactionId, userId: session.userId, note });
  } catch (err) {
    return failure(err);
  }
  await audit(core.db, session, 'bank.tx.ignore', 'bank_transaction', transactionId, { note });
  revalidate();
  return ok('ignored');
}

/** "Mark as resolved": closes a fully allocated Klärfall (e.g. overpayment refunded on the order). */
export async function resolveTransactionAction(
  transactionId: string,
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  const note = text(fd, 'note')?.slice(0, 1000);
  if (!note) return fieldErrors({ note: 'required' });
  try {
    await resolveBankTransaction(core, { transactionId, userId: session.userId, note });
  } catch (err) {
    return failure(err);
  }
  await audit(core.db, session, 'bank.tx.resolve', 'bank_transaction', transactionId, { note });
  revalidate();
  return ok('resolvedMarked');
}

export async function rematchTransactionAction(
  transactionId: string,
  _prev: BankingActionState,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  const core = getCore();
  try {
    const result = await rematchBankTransaction(core, transactionId);
    await audit(core.db, session, 'bank.tx.rematch', 'bank_transaction', transactionId, {
      status: result.status,
      reason: result.reviewReason,
    });
  } catch (err) {
    return failure(err);
  }
  revalidate();
  return ok('rematched');
}

/** "Zuordnung aufheben": undoes one allocation (wrong order) – the order awaits payment again. */
export async function reverseAllocationAction(
  allocationId: string,
  _prev: BankingActionState,
  fd: FormData,
): Promise<BankingActionState> {
  const session = await requireAdmin(ROLES);
  if (!z.uuid().safeParse(allocationId).success) return formError('notFound');
  const core = getCore();
  const reason = text(fd, 'reason')?.slice(0, 1000);
  if (!reason) return fieldErrors({ reason: 'required' });
  try {
    const result = await reverseBankAllocation(core, {
      allocationId,
      userId: session.userId,
      reason,
    });
    await audit(
      core.db,
      session,
      'bank.allocation.reverse',
      'bank_transaction',
      result.bankTransactionId,
      {
        allocationId,
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        orderStatus: result.orderStatus,
        reopened: result.reopened,
        ticketsVoided: result.ticketsVoided,
        creditNote: result.creditNote?.number ?? null,
        reason,
      },
    );
    revalidate();
    return ok(result.reopened ? 'reversedReopened' : 'reversed', {
      values: { order: result.orderNumber },
    });
  } catch (err) {
    return failure(err);
  }
}

export interface AssignableOrder {
  id: string;
  orderNumber: string;
  status: string;
  name: string;
  email: string | null;
  paymentReference: string | null;
  totalGross: number;
  amountPaid: number;
  currency: string;
}

/** Order search for the "assign to another order" box (number, reference, name, e-mail). */
export async function searchAssignableOrders(query: string): Promise<AssignableOrder[]> {
  await requireAdmin(ROLES);
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  const result = await searchOrders(getCore(), { q, page: 1, pageSize: 10 });
  return result.rows.map((r) => ({
    id: r.id,
    orderNumber: r.orderNumber,
    status: r.status,
    name: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email,
    paymentReference: r.paymentReference,
    totalGross: r.totalGross,
    amountPaid: r.amountPaid,
    currency: r.currency,
  }));
}
