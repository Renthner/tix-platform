/**
 * Bank reconciliation against real PostgreSQL + Redis: statement import + dedupe, the
 * matching engine (auto match, Klärfälle reasons, candidates, manual assignment, collective
 * transfers, tolerance), FinTS TAN handling with a scripted client, finAPI with mocked HTTP
 * and the scheduler tick.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  bankConnections,
  bankStatementImports,
  bankTanChallenges,
  bankTransactionAllocations,
  bankTransactions,
  createDb,
  customers,
  loadRootEnv,
  orders,
  payments,
  systemSettings,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { buildPaymentReference } from '@tix/shared';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { BankAccount, BankingInformation, FinTSConfig, Statement } from 'lib-fints';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignBankTransaction,
  bankSyncTick,
  clearFinApiTokenCache,
  createCoreContext,
  deleteBankConnection,
  ignoreBankTransaction,
  importStatementFile,
  invalidateSettings,
  matchBankTransactions,
  rematchBankTransaction,
  resolveBankTransaction,
  respondToTanChallenge,
  runBankSync,
  saveBankAccount,
  saveBankConnection,
  startFinApiWebForm,
  startSyncRun,
  syncFinTs,
  BankSyncError,
  type CoreContext,
  type FinTsClientPort,
  type ObjectStorage,
} from '../src';

loadRootEnv();
/** lib-fints does not export its TanMethod type from the package root. */
type TanMethod = FinTSConfig['availableTanMethods'][number];
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const OWN_IBAN = 'DE89370400440532013000';
const PAYER_IBAN = 'DE02120300000000202051';

interface Entry {
  amount: number;
  name?: string;
  iban?: string;
  text?: string;
  date?: string;
  currency?: string;
}

function camt(entries: Entry[], id = randomUUID()): Uint8Array {
  const ntry = entries
    .map((e) => {
      const debit = e.amount < 0;
      const party = debit ? 'Cdtr' : 'Dbtr';
      return `<Ntry><Amt Ccy="${e.currency ?? 'EUR'}">${(Math.abs(e.amount) / 100).toFixed(2)}</Amt>
        <CdtDbtInd>${debit ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>${e.date ?? '2026-03-02'}</Dt></BookgDt><ValDt><Dt>${e.date ?? '2026-03-02'}</Dt></ValDt>
        <NtryDtls><TxDtls>
          <RltdPties><${party}><Nm>${e.name ?? 'Unknown'}</Nm></${party}>
          ${e.iban ? `<${party}Acct><Id><IBAN>${e.iban}</IBAN></Id></${party}Acct>` : ''}</RltdPties>
          <RmtInf><Ustrd>${e.text ?? ''}</Ustrd></RmtInf>
        </TxDtls></NtryDtls></Ntry>`;
    })
    .join('\n');
  return new Uint8Array(
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>${OWN_IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>${ntry}</Stmt>
</BkToCstmrStmt></Document>`),
  );
}

describe.skipIf(!adminUrl || !redisUrl)('bank reconciliation (integration)', () => {
  const dbName = `tix_bank_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let accountId: string;
  let customerId: string;
  let orderSeq = 0;
  const stored = new Map<string, Uint8Array>();

  const storage = {
    put: async (_bucket: string, key: string, body: Uint8Array | string) => {
      stored.set(key, typeof body === 'string' ? Buffer.from(body) : body);
    },
    get: async (_bucket: string, key: string) => ({
      body: stored.get(key)!,
      contentType: undefined,
    }),
    delete: async (_bucket: string, key: string) => {
      stored.delete(key);
    },
  } as unknown as ObjectStorage;

  async function createOrder(
    total: number,
    options: {
      status?: 'AWAITING_PAYMENT' | 'CANCELLED' | 'PAID';
      first?: string;
      last?: string;
      currency?: string;
    } = {},
  ): Promise<{ id: string; reference: string; orderNumber: string }> {
    orderSeq += 1;
    const reference = buildPaymentReference('TIX', 2026, String(4000 + orderSeq));
    const orderNumber = `T-${orderSeq}-${randomUUID().slice(0, 4)}`;
    const status = options.status ?? 'AWAITING_PAYMENT';
    const now = new Date('2026-03-01T10:00:00Z');
    const [row] = await handle.db
      .insert(orders)
      .values({
        orderNumber,
        customerId,
        status,
        channel: 'ONLINE',
        paymentMethod: 'BANK_TRANSFER',
        email: 'buyer@example.invalid',
        firstName: options.first ?? 'Max',
        lastName: options.last ?? 'Mustermann',
        locale: 'de',
        currency: options.currency ?? 'EUR',
        subtotalGross: total,
        totalGross: total,
        totalNet: total,
        totalTax: 0,
        paymentReference: reference,
        paymentDueAt: new Date('2026-03-10T23:00:00Z'),
        amountPaid: status === 'PAID' ? total : 0,
        paidAt: status === 'PAID' ? now : null,
        cancelledAt: status === 'CANCELLED' ? now : null,
        createdAt: now,
      })
      .returning({ id: orders.id });
    return { id: row!.id, reference, orderNumber };
  }

  async function importAndMatch(entries: Entry[]) {
    const [result] = await importStatementFile(ctx, {
      account: { id: accountId, iban: OWN_IBAN, currency: 'EUR' },
      source: 'UPLOAD',
      fileName: 'statement.xml',
      bytes: camt(entries),
    });
    expect(result!.status).toBe('COMPLETED');
    await matchBankTransactions(ctx, result!.insertedIds);
    const rows = await handle.db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.importId, result!.importId!))
      .orderBy(bankTransactions.createdAt);
    return { result: result!, rows };
  }

  const orderRow = async (id: string) =>
    (await handle.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  const txRow = async (id: string) =>
    (await handle.db.select().from(bankTransactions).where(eq(bankTransactions.id, id)))[0]!;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 10 });
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(`k1:${randomBytes(32).toString('base64')}`)),
      storage,
    });
    invalidateSettings();
    const account = await saveBankAccount(ctx, null, {
      name: 'Main account',
      accountHolder: 'Example Club',
      iban: 'DE89 3704 0044 0532 0130 00',
      bic: 'TESTDEFFXXX',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
      isActive: true,
    });
    accountId = account.id;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email: 'buyer@example.invalid', firstName: 'Max', lastName: 'Mustermann' })
      .returning({ id: customers.id });
    customerId = customer!.id;
  });

  afterAll(async () => {
    invalidateSettings();
    clearFinApiTokenCache();
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('validates accounts: IBAN checksum, unique IBAN, single default', async () => {
    await expect(
      saveBankAccount(ctx, null, {
        name: 'Bad',
        accountHolder: 'X',
        iban: 'DE89370400440532013001',
        currency: 'EUR',
        isDefaultForBankTransfer: false,
        isActive: true,
      }),
    ).rejects.toThrow();
    await expect(
      saveBankAccount(ctx, null, {
        name: 'Dup',
        accountHolder: 'X',
        iban: OWN_IBAN,
        currency: 'EUR',
        isDefaultForBankTransfer: false,
        isActive: true,
      }),
    ).rejects.toMatchObject({ code: 'IBAN_TAKEN' });
  });

  it('auto-matches an exact payment, marks the order PAID and is idempotent', async () => {
    const order = await createOrder(4990);
    const { result, rows } = await importAndMatch([
      {
        amount: 4990,
        name: 'Max Mustermann',
        iban: PAYER_IBAN,
        text: `${order.reference.replace(/-/g, ' ').replace('0', 'O')} Karten`,
      },
      { amount: -1200, name: 'Bank', text: 'Fees' },
    ]);
    expect(rows).toHaveLength(2);
    const credit = rows.find((r) => r.amount > 0)!;
    const debit = rows.find((r) => r.amount < 0)!;
    expect(debit.matchStatus).toBe('IGNORED');
    const after = await txRow(credit.id);
    expect(after.matchStatus).toBe('AUTO_MATCHED');
    expect(after.extractedReference).toBe(order.reference);
    expect((await orderRow(order.id)).status).toBe('PAID');
    const allocations = await handle.db
      .select()
      .from(bankTransactionAllocations)
      .where(eq(bankTransactionAllocations.bankTransactionId, credit.id));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ method: 'AUTO', amount: 4990, orderId: order.id });

    // Same file again → file dedupe; matcher again → no second payment.
    const [again] = await importStatementFile(ctx, {
      account: { id: accountId, iban: OWN_IBAN, currency: 'EUR' },
      source: 'UPLOAD',
      fileName: 'statement.xml',
      bytes: stored.get(
        (
          await handle.db
            .select()
            .from(bankStatementImports)
            .where(eq(bankStatementImports.id, result.importId!))
        )[0]!.objectKey,
      )!,
    });
    expect(again!.status).toBe('DUPLICATE_FILE');
    await matchBankTransactions(ctx, [credit.id]);
    await rematchBankTransaction(ctx, credit.id);
    const paymentRows = await handle.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, order.id));
    expect(paymentRows).toHaveLength(1);
  });

  it('deduplicates the same booking delivered in another file', async () => {
    const order = await createOrder(1500);
    const entry = {
      amount: 1500,
      name: 'Erika Musterfrau',
      iban: PAYER_IBAN,
      text: order.reference,
    };
    await importAndMatch([entry]);
    const [second] = await importStatementFile(ctx, {
      account: { id: accountId, iban: OWN_IBAN, currency: 'EUR' },
      source: 'UPLOAD',
      fileName: 'other.xml',
      bytes: camt([entry, { amount: 700, name: 'New', text: 'other' }]),
    });
    expect(second).toMatchObject({
      status: 'COMPLETED',
      transactionCount: 2,
      importedCount: 1,
      duplicateCount: 1,
    });
  });

  it('rejects files of another account', async () => {
    const xml = Buffer.from(camt([{ amount: 100, text: 'x' }]))
      .toString()
      .replace(OWN_IBAN, PAYER_IBAN);
    const [r] = await importStatementFile(ctx, {
      account: { id: accountId, iban: OWN_IBAN, currency: 'EUR' },
      source: 'UPLOAD',
      fileName: 'foreign.xml',
      bytes: new Uint8Array(Buffer.from(xml)),
    });
    expect(r!.status).toBe('FAILED');
    expect(r!.errorMessage).toMatch(/another account/);
  });

  it('puts under- and overpayments into review and assigns them manually', async () => {
    const under = await createOrder(5000);
    const over = await createOrder(3000);
    const { rows } = await importAndMatch([
      { amount: 4000, name: 'Max Mustermann', text: under.reference },
      { amount: 3500, name: 'Max Mustermann', text: over.reference },
    ]);
    const u = rows.find((r) => r.amount === 4000)!;
    const o = rows.find((r) => r.amount === 3500)!;
    expect(u).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'UNDERPAYMENT' });
    expect(u.matchCandidates?.[0]).toMatchObject({ orderId: under.id, reasons: ['REFERENCE'] });
    expect(o).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' });
    expect((await orderRow(under.id)).status).toBe('AWAITING_PAYMENT');

    const adminId = null as unknown as string; // no admin user in this DB – FK allows null
    const partial = await assignBankTransaction(ctx, {
      transactionId: u.id,
      orderId: under.id,
      userId: adminId,
    });
    expect(partial).toMatchObject({
      payment: 'PARTIAL',
      outstanding: 1000,
      overpayment: 0,
      unassigned: 0,
    });
    expect((await txRow(u.id)).matchStatus).toBe('MANUALLY_MATCHED');
    const overpaid = await assignBankTransaction(ctx, {
      transactionId: o.id,
      orderId: over.id,
      userId: adminId,
    });
    expect(overpaid).toMatchObject({ payment: 'PAID', overpayment: 500, unassigned: 0 });
    expect((await orderRow(over.id)).status).toBe('PAID');
    await expect(
      assignBankTransaction(ctx, { transactionId: o.id, orderId: over.id, userId: adminId }),
    ).rejects.toMatchObject({ code: 'TX_RESOLVED' });
  });

  it('suggests candidates for typos, names and amounts', async () => {
    const typo = await createOrder(2200, { first: 'Hans', last: 'Müller' });
    const [prefix, year, number] = typo.reference.split('-');
    const wrongCheck = `${prefix}-${year}-${number}-${(Number(typo.reference.slice(-1)) + 1) % 10}`;
    const named = await createOrder(1890, { first: 'Sabine', last: 'Beispielfrau' });
    const { rows } = await importAndMatch([
      { amount: 2200, name: 'Hans Mueller', text: `Bestellung ${wrongCheck}` },
      { amount: 1890, name: 'BEISPIELFRAU, SABINE', text: 'Tickets Konzert' },
      { amount: 999, name: 'Nobody Known', text: 'Mitgliedsbeitrag' },
    ]);
    const t1 = rows.find((r) => r.amount === 2200)!;
    expect(t1).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'UNKNOWN_REFERENCE' });
    expect(t1.matchCandidates?.[0]?.orderId).toBe(typo.id);
    expect(t1.matchCandidates?.[0]?.reasons).toEqual(
      expect.arrayContaining(['REFERENCE_CHECKSUM', 'AMOUNT']),
    );
    const t2 = rows.find((r) => r.amount === 1890)!;
    expect(t2).toMatchObject({ reviewReason: 'NAME_MATCH_ONLY' });
    expect(t2.matchCandidates?.[0]).toMatchObject({ orderId: named.id });
    expect(t2.matchCandidates?.[0]?.reasons).toEqual(expect.arrayContaining(['NAME', 'AMOUNT']));
    const t3 = rows.find((r) => r.amount === 999)!;
    expect(t3).toMatchObject({ reviewReason: 'NO_REFERENCE', matchCandidates: [] });

    await ignoreBankTransaction(ctx, {
      transactionId: t3.id,
      userId: null as unknown as string,
      note: 'membership fee',
    });
    expect(await txRow(t3.id)).toMatchObject({
      matchStatus: 'IGNORED',
      reviewNote: 'membership fee',
    });
    const reopened = await rematchBankTransaction(ctx, t3.id);
    expect(reopened).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'NO_REFERENCE' });
  });

  it('flags cancelled orders, paid orders and currency mismatches', async () => {
    const cancelled = await createOrder(1000, { status: 'CANCELLED' });
    const paid = await createOrder(1100, { status: 'PAID' });
    const chf = await createOrder(1200, { currency: 'CHF' });
    const { rows } = await importAndMatch([
      { amount: 1000, text: cancelled.reference },
      { amount: 1100, text: paid.reference },
      { amount: 1200, text: chf.reference },
    ]);
    expect(rows.find((r) => r.amount === 1000)).toMatchObject({
      reviewReason: 'ORDER_NOT_PAYABLE',
    });
    expect(rows.find((r) => r.amount === 1100)).toMatchObject({ reviewReason: 'OVERPAYMENT' });
    expect(rows.find((r) => r.amount === 1200)).toMatchObject({
      reviewReason: 'CURRENCY_MISMATCH',
    });
    await expect(
      assignBankTransaction(ctx, {
        transactionId: rows.find((r) => r.amount === 1000)!.id,
        orderId: cancelled.id,
        userId: null as unknown as string,
      }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
  });

  it('keeps an overpayment on a fully allocated transfer in review until an admin resolves it', async () => {
    const paid = await createOrder(1300, { status: 'PAID' });
    const { rows } = await importAndMatch([{ amount: 1300, text: paid.reference }]);
    const tx = rows[0]!;
    expect(tx).toMatchObject({ matchStatus: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' });
    // State left behind by the "order got paid meanwhile" race of the auto-matcher: the payment
    // was booked and allocated, yet the transfer stays in review as OVERPAYMENT.
    await handle.db.insert(bankTransactionAllocations).values({
      bankTransactionId: tx.id,
      orderId: paid.id,
      amount: 1300,
      method: 'AUTO',
    });
    // Fully allocated: nothing left to assign, and re-running the matcher does not close the case.
    await expect(
      assignBankTransaction(ctx, { transactionId: tx.id, orderId: paid.id, userId: null as never }),
    ).rejects.toMatchObject({ code: 'TX_RESOLVED' });
    const rematched = await rematchBankTransaction(ctx, tx.id);
    expect(rematched).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' });
    expect(await txRow(tx.id)).toMatchObject({
      matchStatus: 'NEEDS_REVIEW',
      reviewReason: 'OVERPAYMENT',
    });

    await resolveBankTransaction(ctx, {
      transactionId: tx.id,
      userId: null as never,
      note: 'Excess refunded manually',
    });
    expect(await txRow(tx.id)).toMatchObject({
      matchStatus: 'MANUALLY_MATCHED',
      reviewReason: null,
      reviewNote: 'Excess refunded manually',
    });
    await expect(
      resolveBankTransaction(ctx, { transactionId: tx.id, userId: null as never, note: 'again' }),
    ).rejects.toMatchObject({ code: 'TX_RESOLVED' });
  });

  it('refuses to mark a partly unassigned transaction as resolved', async () => {
    const order = await createOrder(5000);
    const { rows } = await importAndMatch([{ amount: 4000, text: order.reference }]);
    await expect(
      resolveBankTransaction(ctx, { transactionId: rows[0]!.id, userId: null as never, note: 'x' }),
    ).rejects.toMatchObject({ code: 'TX_NOT_FULLY_ASSIGNED' });
  });

  it('puts a transaction allocated for more than its amount back into review', async () => {
    const order = await createOrder(5000);
    const { rows } = await importAndMatch([{ amount: 4100, text: order.reference }]);
    const tx = rows[0]!;
    expect(tx.matchStatus).toBe('NEEDS_REVIEW');
    // Earlier double assignment: 2 x 2500 allocated for a 4100 transfer.
    await handle.db.insert(bankTransactionAllocations).values([
      { bankTransactionId: tx.id, orderId: order.id, amount: 2500, method: 'MANUAL' },
      { bankTransactionId: tx.id, orderId: order.id, amount: 2500, method: 'MANUAL' },
    ]);
    const result = await rematchBankTransaction(ctx, tx.id);
    expect(result).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'OVERPAYMENT' });
    expect((await txRow(tx.id)).matchStatus).toBe('NEEDS_REVIEW');
  });

  it('allows only one allocation per payment', async () => {
    const order = await createOrder(1500);
    const { rows } = await importAndMatch([{ amount: 1500, text: order.reference }]);
    const [allocation] = await handle.db
      .select()
      .from(bankTransactionAllocations)
      .where(eq(bankTransactionAllocations.bankTransactionId, rows[0]!.id));
    expect(allocation?.paymentId).toBeTruthy();
    await expect(
      handle.db.insert(bankTransactionAllocations).values({
        bankTransactionId: rows[0]!.id,
        orderId: order.id,
        paymentId: allocation!.paymentId,
        amount: 1500,
        method: 'MANUAL',
      }),
    ).rejects.toThrow();
  });

  it('splits a collective transfer over several referenced orders', async () => {
    const a = await createOrder(2000);
    const b = await createOrder(3000);
    const { rows } = await importAndMatch([
      { amount: 5000, text: `${a.reference} und ${b.reference}` },
    ]);
    expect(rows[0]!.matchStatus).toBe('AUTO_MATCHED');
    expect((await orderRow(a.id)).status).toBe('PAID');
    expect((await orderRow(b.id)).status).toBe('PAID');
    const allocations = await handle.db
      .select()
      .from(bankTransactionAllocations)
      .where(eq(bankTransactionAllocations.bankTransactionId, rows[0]!.id));
    expect(allocations.map((x) => x.amount).sort()).toEqual([2000, 3000]);
  });

  it('honours the configured tolerance', async () => {
    await handle.db
      .insert(systemSettings)
      .values({
        key: 'bankTransfer',
        value: {
          enabled: true,
          paymentReferencePrefix: 'TIX',
          paymentTermDays: 5,
          countBusinessDaysOnly: true,
          holidayRegion: null,
          reminderAfterDays: 4,
          cancelAfterDays: 8,
          disableDaysBeforeEvent: 7,
          autoMatchToleranceCents: 50,
        },
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: { autoMatchToleranceCents: 50, paymentReferencePrefix: 'TIX' } },
      });
    invalidateSettings();
    const order = await createOrder(2500);
    const { rows } = await importAndMatch([{ amount: 2530, text: order.reference }]);
    expect(rows[0]!.matchStatus).toBe('AUTO_MATCHED');
    expect((await orderRow(order.id)).status).toBe('PAID');
    await handle.db.delete(systemSettings).where(eq(systemSettings.key, 'bankTransfer'));
    invalidateSettings();
  });

  // ── FinTS ───────────────────────────────────────────────────────────────────
  function fakeFinTs(options: {
    decoupled?: boolean;
    approveAfterPolls?: number;
    methods?: number[];
  }) {
    const methods: TanMethod[] = [
      {
        id: 942,
        name: 'mobileTAN',
        version: 7,
        isDecoupled: false,
        activeTanMediaCount: 1,
        activeTanMedia: ['Phone'],
        tanMediaRequirement: 1,
      },
      {
        id: 946,
        name: 'App approval',
        version: 7,
        isDecoupled: true,
        activeTanMediaCount: 0,
        activeTanMedia: [],
        tanMediaRequirement: 0,
        decoupled: {
          maxStatusRequests: 10,
          waitingSecondsBeforeFirstStatusRequest: 1,
          waitingSecondsBetweenStatusRequests: 1,
          manualConfirmationAllowed: true,
          autoConfirmationAllowed: true,
        },
      },
    ].filter((m) => (options.methods ?? [942, 946]).includes(m.id)) as TanMethod[];
    const info: BankingInformation = { systemId: '0', bankMessages: [] };
    let selected: TanMethod | undefined;
    let polls = 0;
    const account = {
      accountNumber: '0532013000',
      bank: { country: 280, bankId: '37040044' },
      iban: OWN_IBAN,
      customerId: 'user',
      accountType: 'CheckingAccount',
      currency: 'EUR',
      holder1: 'Example Club',
    } as unknown as BankAccount;
    const ok = {
      dialogId: 'd',
      success: true,
      bankingInformationUpdated: true,
      bankAnswers: [],
      requiresTan: false,
    };
    const statement: Statement = {
      openingBalance: { date: new Date(2026, 2, 1), currency: 'EUR', value: 0 },
      closingBalance: { date: new Date(2026, 2, 2), currency: 'EUR', value: 0 },
      transactions: [
        {
          valueDate: new Date(2026, 2, 2),
          entryDate: new Date(2026, 2, 2),
          fundsCode: 'C',
          amount: 12.5,
          transactionType: 'NMSC',
          customerReference: '',
          bankReference: 'B1',
          purpose: 'FinTS payment test',
          remoteName: 'Max Mustermann',
          remoteAccountNumber: PAYER_IBAN,
        },
      ],
    };
    const client: FinTsClientPort = {
      config: {
        bankingInformation: info,
        get availableTanMethods() {
          return info.bpd ? methods : [];
        },
        get selectedTanMethod() {
          return selected;
        },
      },
      selectTanMethod: (id: number) => {
        selected = methods.find((m) => m.id === id);
      },
      selectTanMedia: () => {},
      synchronize: async () => {
        if (!info.bpd) {
          info.bpd = {
            version: 1,
            bankId: '37040044',
            bankName: 'Testbank',
            supportedTanMethods: methods,
            availableTanMethodIds: methods.map((m) => m.id),
            allowedTransactions: [],
          } as unknown as BankingInformation['bpd'];
        } else {
          info.upd = {
            version: 1,
            usage: 0,
            bankAccounts: [account],
          } as unknown as BankingInformation['upd'];
        }
        return ok;
      },
      synchronizeWithTan: async () => ok,
      canGetAccountStatements: () => true,
      getAccountStatements: async () => ({
        ...ok,
        requiresTan: true,
        tanReference: 'REF-1',
        tanChallenge: 'Please enter the TAN for the account statement',
        statements: [],
      }),
      getAccountStatementsWithTan: async (_ref: string, tan?: string) => {
        if (options.decoupled) {
          polls += 1;
          if (polls < (options.approveAfterPolls ?? 1)) {
            return { ...ok, requiresTan: true, tanReference: 'REF-1', statements: [] };
          }
          return { ...ok, statements: [statement] };
        }
        if (tan !== '123456')
          return {
            ...ok,
            success: false,
            bankAnswers: [{ code: 9941, text: 'TAN falsch' }],
            statements: [],
          };
        return { ...ok, statements: [statement] };
      },
    };
    return client;
  }

  async function finTsConnection(tanMethodId?: number) {
    return saveBankConnection(ctx, null, {
      bankAccountId: accountId,
      name: `FinTS ${randomUUID().slice(0, 4)}`,
      isActive: true,
      pollIntervalSeconds: null,
      config: {
        adapter: 'FINTS',
        serverUrl: 'https://fints.bank.example/fints',
        bankCode: '37040044',
        userId: 'user',
        productId: 'TESTPRODUCT',
        ...(tanMethodId ? { tanMethodId } : {}),
      },
      secrets: { pin: '12345' },
    });
  }

  const connectionRow = async (id: string) =>
    (await handle.db.select().from(bankConnections).where(eq(bankConnections.id, id)))[0]!;

  it('FinTS: asks for a TAN procedure when the bank offers several', async () => {
    const { id } = await finTsConnection();
    const connection = await connectionRow(id);
    const run = await startSyncRun(ctx, { connectionId: id, trigger: 'MANUAL' });
    await expect(
      syncFinTs(ctx, {
        connection,
        account: { iban: OWN_IBAN, currency: 'EUR' },
        syncRunId: run!.id,
        pin: '12345',
        lastSuccessfulSyncAt: null,
        clientFactory: () => fakeFinTs({}),
      }),
    ).rejects.toMatchObject({ code: 'FINTS_TAN_METHOD_REQUIRED' });
    const state = (await connectionRow(id)).state as {
      setupIssue: string;
      tanMethods: { id: number }[];
    };
    expect(state.setupIssue).toBe('TAN_METHOD_REQUIRED');
    expect(state.tanMethods.map((m) => m.id)).toEqual([942, 946]);
    await deleteBankConnection(ctx, id).catch(() => {});
  });

  it('FinTS: forwards the TAN entered in the Admin Portal and imports statements', async () => {
    const { id } = await finTsConnection(942);
    const order = await createOrder(1250);
    const client = fakeFinTs({});
    const original = client.getAccountStatementsWithTan;
    client.getAccountStatementsWithTan = async (ref, tan) => {
      const res = await original(ref, tan);
      res.statements[0]!.transactions[0]!.purpose = `Tickets ${order.reference}`;
      return res;
    };
    const syncing = runBankSync(
      ctx,
      { connectionId: id, trigger: 'MANUAL' },
      { fintsClientFactory: () => client, tanTimeoutMs: 20_000 },
    );
    // Admin answers the challenge.
    let challengeId: string | undefined;
    for (let i = 0; i < 100 && !challengeId; i += 1) {
      const [c] = await handle.db
        .select()
        .from(bankTanChallenges)
        .where(
          and(eq(bankTanChallenges.connectionId, id), eq(bankTanChallenges.status, 'PENDING')),
        );
      // The challenge row is written just before the connection status: wait for both.
      if (c && (await connectionRow(id)).lastSyncStatus === 'TAN_REQUIRED') {
        challengeId = c.id;
        expect(c.challengeText).toMatch(/TAN/);
      } else await new Promise((r) => setTimeout(r, 100));
    }
    expect(challengeId).toBeDefined();
    expect((await connectionRow(id)).lastSyncStatus).toBe('TAN_REQUIRED');
    await expect(
      respondToTanChallenge(ctx, {
        challengeId: challengeId!,
        userId: null as unknown as string,
        response: { kind: 'TAN', tan: '12 34 56!' },
      }),
    ).rejects.toMatchObject({ code: 'TAN_INVALID' });
    await respondToTanChallenge(ctx, {
      challengeId: challengeId!,
      userId: null as unknown as string,
      response: { kind: 'TAN', tan: '123456' },
    });
    const outcome = await syncing;
    expect(outcome).toMatchObject({
      status: 'SUCCEEDED',
      counts: { fetched: 1, imported: 1, matched: 1 },
    });
    const [challenge] = await handle.db
      .select()
      .from(bankTanChallenges)
      .where(eq(bankTanChallenges.id, challengeId!));
    expect(challenge!.status).toBe('COMPLETED');
    expect(await redis.exists(ctx.keys.bankTanResponse(challengeId!))).toBe(0);
    expect((await orderRow(order.id)).status).toBe('PAID');
    const connection = await connectionRow(id);
    expect(connection.lastSyncStatus).toBe('SUCCEEDED');
    expect((connection.state as { accounts: unknown[] }).accounts).toHaveLength(1);
    await deleteBankConnection(ctx, id);
  });

  it('FinTS: polls the bank for decoupled app approvals', async () => {
    const { id } = await finTsConnection(946);
    const connection = await connectionRow(id);
    const run = await startSyncRun(ctx, { connectionId: id, trigger: 'MANUAL' });
    const result = await syncFinTs(ctx, {
      connection,
      account: { iban: OWN_IBAN, currency: 'EUR' },
      syncRunId: run!.id,
      pin: '12345',
      lastSuccessfulSyncAt: null,
      clientFactory: () => fakeFinTs({ decoupled: true, approveAfterPolls: 2, methods: [946] }),
      pollIntervalMs: 50,
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      amount: 1250,
      bookingDate: '2026-03-02',
      counterpartyIban: PAYER_IBAN,
    });
    const challenges = await handle.db
      .select()
      .from(bankTanChallenges)
      .where(eq(bankTanChallenges.connectionId, id));
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ isDecoupled: true, status: 'COMPLETED' });
  }, 30_000);

  it('FinTS: an unanswered TAN expires and pauses scheduled polling', async () => {
    const { id } = await saveBankConnection(ctx, null, {
      bankAccountId: accountId,
      name: 'FinTS scheduled',
      isActive: true,
      pollIntervalSeconds: 3600,
      config: {
        adapter: 'FINTS',
        serverUrl: 'https://fints.bank.example/fints',
        bankCode: '37040044',
        userId: 'user2',
        productId: 'TESTPRODUCT',
        tanMethodId: 942,
      },
      secrets: { pin: '12345' },
    });
    const outcome = await runBankSync(
      ctx,
      { connectionId: id, trigger: 'SCHEDULED' },
      { fintsClientFactory: () => fakeFinTs({}), tanTimeoutMs: 1500 },
    );
    expect(outcome).toMatchObject({ status: 'FAILED' });
    expect((outcome as { error: string }).error).toMatch(/TAN_EXPIRED/);
    const connection = await connectionRow(id);
    expect(connection.nextSyncAt).toBeNull();
    expect(connection.lastSyncStatus).toBe('FAILED');
    const [challenge] = await handle.db
      .select()
      .from(bankTanChallenges)
      .where(eq(bankTanChallenges.connectionId, id));
    expect(challenge!.status).toBe('EXPIRED');
    await deleteBankConnection(ctx, id);
  }, 20_000);

  // ── finAPI ──────────────────────────────────────────────────────────────────
  function finApiMock(options: { webFormRequired?: boolean }) {
    const calls: string[] = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.host}${url.pathname}`);
      if (url.pathname === '/api/v2/oauth/token') {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('client_secret') !== 'secret') return json(401, { error: 'invalid_client' });
        return json(200, { access_token: `${form.get('grant_type')}-token`, expires_in: 3600 });
      }
      if (url.pathname === '/api/v2/users' && method === 'POST')
        return json(201, { id: 'user-1', password: 'pw-1' });
      if (url.pathname === '/api/v2/users' && method === 'DELETE')
        return new Response(null, { status: 200 });
      if (url.pathname === '/api/webForms/bankConnectionImport') {
        const body = JSON.parse(String(init?.body)) as { bank?: unknown };
        if (body.bank) return json(422, { code: 'BANK_NOT_SUPPORTED', description: 'not found' });
        return json(201, {
          id: 'wf-1',
          url: 'https://webform-sandbox.finapi.io/wf/wf-1',
          status: 'NOT_YET_OPENED',
          expiresAt: '2026-03-02T12:20:00.000Z',
        });
      }
      if (url.pathname === '/api/webForms/wf-1') {
        return json(200, {
          id: 'wf-1',
          url: 'x',
          status: 'COMPLETED',
          expiresAt: 'x',
          payload: { bankConnectionId: 77 },
        });
      }
      if (url.pathname === '/api/v2/bankConnections/77') {
        return json(200, {
          id: 77,
          bank: { name: 'Testbank' },
          interfaces: [
            {
              bankingInterface: 'XS2A',
              aisConsent: { status: 'PRESENT', expiresAt: '2026-08-30T00:00:00.000Z' },
            },
          ],
        });
      }
      if (url.pathname === '/api/v2/accounts') {
        return json(200, {
          accounts: [
            { id: 500, bankConnectionId: 77, iban: PAYER_IBAN },
            { id: 501, bankConnectionId: 77, iban: OWN_IBAN },
          ],
        });
      }
      if (url.pathname === '/api/tasks/backgroundUpdate')
        return json(201, { id: 'task-1', status: 'IN_PROGRESS' });
      if (url.pathname === '/api/tasks/task-1') {
        return json(
          200,
          options.webFormRequired
            ? {
                id: 'task-1',
                status: 'WEB_FORM_REQUIRED',
                payload: {
                  webForm: {
                    id: 'wf-2',
                    url: 'https://webform-sandbox.finapi.io/wf/wf-2',
                    status: 'NOT_YET_OPENED',
                  },
                },
              }
            : { id: 'task-1', status: 'COMPLETED' },
        );
      }
      if (url.pathname === '/api/v2/transactions') {
        expect(url.searchParams.get('view')).toBe('bankView');
        expect(url.searchParams.get('accountIds')).toBe('501');
        const page = Number(url.searchParams.get('page'));
        const tx = (id: number, amount: number, purpose: string, extra: object = {}) => ({
          id,
          accountId: 501,
          bankBookingDate: '2026-03-02',
          valueDate: '2026-03-02',
          amount,
          purpose,
          counterpartName: 'Max Mustermann',
          counterpartIban: PAYER_IBAN,
          ...extra,
        });
        return json(200, {
          transactions:
            page === 1
              ? [tx(1, 33.3, `finapi ${finApiOrderRef}`), tx(2, -5, 'fee')]
              : [tx(3, 0.01, 'Zwischensaldo', { isAdjustingEntry: true })],
          paging: { page, perPage: 500, pageCount: 2, totalCount: 3 },
        });
      }
      return json(404, {
        errors: [{ code: 'ENTITY_NOT_FOUND', message: `no mock for ${url.pathname}` }],
      });
    };
    return { fetch: fetchMock as typeof fetch, calls };
  }
  let finApiOrderRef = '';

  it('finAPI: web form import, background update, transaction download and disconnect', async () => {
    clearFinApiTokenCache();
    const order = await createOrder(3330);
    finApiOrderRef = order.reference;
    const mock = finApiMock({});
    const deps = { fetch: mock.fetch, sleep: async () => {}, taskPollMs: 0 };
    const { id } = await saveBankConnection(ctx, null, {
      bankAccountId: accountId,
      name: 'finAPI',
      isActive: true,
      pollIntervalSeconds: 21_600,
      config: {
        adapter: 'PSD2_FINAPI',
        environment: 'sandbox',
        clientId: 'client',
        backgroundUpdate: true,
      },
      secrets: { clientSecret: 'secret' },
    });
    const connect = await startFinApiWebForm(
      ctx,
      { connectionId: id, language: 'de', returnUrl: 'https://shop.example/admin/banking' },
      deps,
    );
    expect(connect.status).toBe('WEB_FORM');
    const url = new URL((connect as { url: string }).url);
    expect(url.searchParams.get('language')).toBe('de');
    expect(url.searchParams.get('redirectUrl')).toBe('https://shop.example/admin/banking');
    expect(mock.calls.filter((c) => c.endsWith('/bankConnectionImport'))).toHaveLength(2);

    const outcome = await runBankSync(
      ctx,
      { connectionId: id, trigger: 'MANUAL' },
      { finApi: deps },
    );
    expect(outcome).toMatchObject({
      status: 'SUCCEEDED',
      counts: { fetched: 2, imported: 2, matched: 1 },
    });
    const connection = await connectionRow(id);
    expect(connection.consentExpiresAt?.toISOString()).toBe('2026-08-30T00:00:00.000Z');
    expect(connection.state).toMatchObject({
      userId: 'user-1',
      bankConnectionId: 77,
      accountId: 501,
      bankName: 'Testbank',
    });
    expect((await orderRow(order.id)).status).toBe('PAID');

    await deleteBankConnection(ctx, id, deps);
    expect(mock.calls).toContain('DELETE sandbox.finapi.io/api/v2/users');
  });

  it('finAPI: consent renewal needed → data still downloaded, run flagged', async () => {
    clearFinApiTokenCache();
    const mock = finApiMock({ webFormRequired: true });
    const deps = { fetch: mock.fetch, sleep: async () => {}, taskPollMs: 0 };
    const { id } = await saveBankConnection(ctx, null, {
      bankAccountId: accountId,
      name: 'finAPI 2',
      isActive: true,
      pollIntervalSeconds: null,
      config: {
        adapter: 'PSD2_FINAPI',
        environment: 'sandbox',
        clientId: 'client',
        backgroundUpdate: true,
      },
      secrets: { clientSecret: 'secret' },
    });
    await startFinApiWebForm(ctx, { connectionId: id, language: 'en' }, deps);
    const outcome = await runBankSync(
      ctx,
      { connectionId: id, trigger: 'MANUAL' },
      { finApi: deps },
    );
    expect(outcome).toMatchObject({ status: 'FAILED' });
    expect((outcome as { error: string }).error).toMatch(/FINAPI_USER_ACTION_REQUIRED/);
    expect((outcome as { counts: { fetched: number } }).counts.fetched).toBe(2);
    expect((await connectionRow(id)).state).toMatchObject({
      userActionRequired: true,
      webForm: { id: 'wf-2', purpose: 'UPDATE' },
    });
    await deleteBankConnection(ctx, id, deps);
  });

  it('validates connection settings', async () => {
    await expect(
      saveBankConnection(ctx, null, {
        bankAccountId: accountId,
        name: 'too often',
        isActive: true,
        pollIntervalSeconds: 600,
        config: { adapter: 'PSD2_FINAPI', environment: 'sandbox', clientId: 'c' },
        secrets: { clientSecret: 's' },
      }),
    ).rejects.toMatchObject({ code: 'POLL_INTERVAL' });
    await expect(
      saveBankConnection(ctx, null, {
        bankAccountId: accountId,
        name: 'no pin',
        isActive: true,
        pollIntervalSeconds: null,
        config: {
          adapter: 'FINTS',
          serverUrl: 'https://x.example',
          bankCode: '37040044',
          userId: 'u',
          productId: 'p',
        },
        secrets: {},
      }),
    ).rejects.toMatchObject({ code: 'SECRET_REQUIRED' });
  });

  it('scheduler tick claims due connections once and cleans up', async () => {
    const { id } = await saveBankConnection(ctx, null, {
      bankAccountId: accountId,
      name: 'IMAP',
      isActive: true,
      pollIntervalSeconds: 300,
      config: { adapter: 'IMAP', host: 'imap.example.invalid', username: 'bank@example.invalid' },
      secrets: { password: 'pw' },
    });
    const before = await connectionRow(id);
    expect(before.nextSyncAt).not.toBeNull();
    const first = await bankSyncTick(ctx);
    expect(first.queued).toBeGreaterThanOrEqual(1);
    const after = await connectionRow(id);
    expect(after.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + 200_000);
    const second = await bankSyncTick(ctx);
    expect(second.queued).toBe(0);
    await deleteBankConnection(ctx, id);
  });

  it('exports BankSyncError for adapters', () => {
    expect(new BankSyncError('X', 'y')).toBeInstanceOf(Error);
  });
});
