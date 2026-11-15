/**
 * Interim (MT942) and camt.054 handling against real PostgreSQL + Redis: interim entries never
 * pay an order and are superseded by the final booking, camt.054 duplicate rules, aggregate
 * (batch) entries. All fixtures are synthetic.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  bankTransactions,
  createDb,
  customers,
  loadRootEnv,
  orders,
  payments,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { buildPaymentReference } from '@tix/shared';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignBankTransaction,
  createCoreContext,
  importStatementFile,
  invalidateSettings,
  matchBankTransactions,
  rematchBankTransaction,
  saveBankAccount,
  type CoreContext,
  type ObjectStorage,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const OWN_IBAN = 'DE89370400440532013000';
const PAYER_IBAN = 'DE02120300000000202051';

interface CamtEntry {
  amount: number;
  /** Omitted BookgDt when undefined and `noBooking` is set. */
  date?: string;
  noBooking?: boolean;
  val?: string;
  ref?: string;
  e2e?: string;
  text?: string;
  iban?: string;
  details?: string[];
}

function camtDoc(
  kind: '053' | '054',
  id: string,
  entries: CamtEntry[],
  created = '2026-03-02T10:00:00',
): Uint8Array {
  const root = kind === '053' ? 'BkToCstmrStmt' : 'BkToCstmrDbtCdtNtfctn';
  const node = kind === '053' ? 'Stmt' : 'Ntfctn';
  const ntry = entries
    .map((e) => {
      const date = e.date ?? '2026-03-02';
      const body = e.details
        ? e.details
            .map(
              (d) =>
                `<TxDtls><RltdPties><Dbtr><Nm>Multi</Nm></Dbtr></RltdPties><RmtInf><Ustrd>${d}</Ustrd></RmtInf></TxDtls>`,
            )
            .join('')
        : `<TxDtls>${e.e2e ? `<Refs><EndToEndId>${e.e2e}</EndToEndId></Refs>` : ''}<RltdPties><Dbtr><Nm>Payer</Nm></Dbtr>${
            e.iban ? `<DbtrAcct><Id><IBAN>${e.iban}</IBAN></Id></DbtrAcct>` : ''
          }</RltdPties><RmtInf><Ustrd>${e.text ?? ''}</Ustrd></RmtInf></TxDtls>`;
      return `<Ntry><Amt Ccy="EUR">${(e.amount / 100).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        ${e.noBooking ? '' : `<BookgDt><Dt>${date}</Dt></BookgDt>`}<ValDt><Dt>${e.val ?? date}</Dt></ValDt>
        ${e.ref ? `<AcctSvcrRef>${e.ref}</AcctSvcrRef>` : ''}
        <NtryDtls>${body}</NtryDtls></Ntry>`;
    })
    .join('\n');
  return new Uint8Array(
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.${kind}.001.02"><${root}>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${created}</CreDtTm></GrpHdr>
<${node}><Id>${id}</Id><Acct><Id><IBAN>${OWN_IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>${ntry}</${node}>
</${root}></Document>`),
  );
}

/** MT940 / MT942 with one credit; `yymmdd` is the booking date. */
function mt(kind: '942' | '940', yymmdd: string, amount: number, text: string, name = 'Payer') {
  const mmdd = yymmdd.slice(2);
  return new Uint8Array(
    Buffer.from(
      [
        `:20:T${kind}${yymmdd}${amount}`,
        ':25:37040044/0532013000',
        kind === '942' ? ':34F:EURD0,' : ':60F:C260301EUR0,00',
        `:61:${yymmdd}${mmdd}CR${(amount / 100).toFixed(2).replace('.', ',')}NTRFNONREF`,
        `:86:166?00GUTSCHRIFT?20SVWZ+${text}?31${PAYER_IBAN}?32${name}`,
        kind === '940' ? ':62F:C260302EUR23,45' : ':90C:1EUR23,45',
        '-',
      ].join('\n'),
    ),
  );
}

describe.skipIf(!adminUrl || !redisUrl)('interim + camt.054 handling (integration)', () => {
  const dbName = `tix_hold_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let accountId: string;
  let customerId: string;
  let orderSeq = 0;
  const stored = new Map<string, Uint8Array>();
  const storage = {
    put: async (_b: string, key: string, body: Uint8Array | string) => {
      stored.set(key, typeof body === 'string' ? Buffer.from(body) : body);
    },
    get: async (_b: string, key: string) => ({ body: stored.get(key)!, contentType: undefined }),
    delete: async (_b: string, key: string) => {
      stored.delete(key);
    },
  } as unknown as ObjectStorage;
  const account = () => ({ id: accountId, iban: OWN_IBAN, currency: 'EUR' });

  async function createOrder(total: number) {
    orderSeq += 1;
    const reference = buildPaymentReference('TIX', 2026, String(7000 + orderSeq));
    const [row] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `H-${orderSeq}-${randomUUID().slice(0, 4)}`,
        customerId,
        status: 'AWAITING_PAYMENT',
        channel: 'ONLINE',
        paymentMethod: 'BANK_TRANSFER',
        email: 'buyer@example.invalid',
        firstName: 'Max',
        lastName: 'Mustermann',
        locale: 'de',
        currency: 'EUR',
        subtotalGross: total,
        totalGross: total,
        totalNet: total,
        totalTax: 0,
        paymentReference: reference,
        paymentDueAt: new Date('2026-03-20T23:00:00Z'),
        amountPaid: 0,
        createdAt: new Date('2026-03-01T10:00:00Z'),
      })
      .returning({ id: orders.id });
    return { id: row!.id, reference };
  }

  async function imp(fileName: string, bytes: Uint8Array) {
    const [r] = await importStatementFile(ctx, {
      account: account(),
      source: 'UPLOAD',
      fileName,
      bytes,
    });
    await matchBankTransactions(ctx, r!.insertedIds);
    return r!;
  }

  const orderRow = async (id: string) =>
    (await handle.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  const rowsOf = (amount: number) =>
    handle.db.select().from(bankTransactions).where(eq(bankTransactions.amount, amount));
  const paymentCount = async (orderId: string) =>
    (await handle.db.select().from(payments).where(eq(payments.orderId, orderId))).length;
  const hold = (r: { rawData: unknown }) => (r.rawData as { hold?: string } | null)?.hold;

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
    accountId = (
      await saveBankAccount(ctx, null, {
        name: 'Main account',
        accountHolder: 'Example Club',
        iban: 'DE89 3704 0044 0532 0130 00',
        bic: 'TESTDEFFXXX',
        currency: 'EUR',
        isDefaultForBankTransfer: true,
        isActive: true,
      })
    ).id;
    customerId = (
      await handle.db
        .insert(customers)
        .values({ email: 'buyer@example.invalid', firstName: 'Max', lastName: 'Mustermann' })
        .returning({ id: customers.id })
    )[0]!.id;
  });

  afterAll(async () => {
    invalidateSettings();
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

  it('pre-note Friday + final Monday: the credit counts once, the order is paid only after the final', async () => {
    const order = await createOrder(1111);
    const interim = await imp('fri.942', mt('942', '260306', 1111, order.reference));
    expect(interim).toMatchObject({ importedCount: 1, insertedIds: [] });
    expect(interim.warnings.join(' ')).toMatch(/interim/i);
    expect((await orderRow(order.id)).status).toBe('AWAITING_PAYMENT');
    expect(await paymentCount(order.id)).toBe(0);

    // The interim row cannot be matched or assigned, not even by hand.
    const [pre] = await rowsOf(1111);
    expect(hold(pre!)).toBe('INTERIM');
    expect(pre!.matchStatus).toBe('IGNORED');
    await expect(rematchBankTransaction(ctx, pre!.id)).rejects.toMatchObject({ code: 'TX_HELD' });
    await expect(
      assignBankTransaction(ctx, {
        transactionId: pre!.id,
        orderId: order.id,
        userId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'TX_HELD' });

    // Final booking on Monday (different booking date).
    const final = await imp('mon.sta', mt('940', '260309', 1111, order.reference));
    expect(final).toMatchObject({ importedCount: 1, duplicateCount: 0 });
    expect((await orderRow(order.id)).status).toBe('PAID');
    expect(await paymentCount(order.id)).toBe(1);
    const rows = await rowsOf(1111);
    expect(rows).toHaveLength(2);
    const finalRow = rows.find((r) => !hold(r))!;
    const interimRow = rows.find((r) => hold(r) === 'INTERIM')!;
    expect((interimRow.rawData as { supersededBy?: string }).supersededBy).toBe(finalRow.id);
    expect(finalRow.matchStatus).toBe('AUTO_MATCHED');
    expect(rows.filter((r) => r.matchStatus === 'NEEDS_REVIEW')).toHaveLength(0);
  });

  it('final statement first, interim report later: superseded at once, nothing matched', async () => {
    const order = await createOrder(1212);
    await imp('final.sta', mt('940', '260309', 1212, order.reference));
    expect((await orderRow(order.id)).status).toBe('PAID');
    const late = await imp('late.942', mt('942', '260306', 1212, order.reference));
    expect(late.insertedIds).toEqual([]);
    const interimRow = (await rowsOf(1212)).find((r) => hold(r) === 'INTERIM')!;
    expect((interimRow.rawData as { supersededBy?: string }).supersededBy).toBeTruthy();
    expect(await paymentCount(order.id)).toBe(1);
  });

  it('rebooked entry with a changed reference is still linked and counted once', async () => {
    const order = await createOrder(1313);
    await imp('i.942', mt('942', '260306', 1313, 'Vorlaeufiger Text ohne Referenz'));
    const final = await imp('f.sta', mt('940', '260309', 1313, order.reference));
    expect(final.importedCount).toBe(1);
    expect((await orderRow(order.id)).status).toBe('PAID');
    const rows = await rowsOf(1313);
    const interimRow = rows.find((r) => hold(r) === 'INTERIM')!;
    expect((interimRow.rawData as { supersededBy?: string }).supersededBy).toBeTruthy();
    expect(await paymentCount(order.id)).toBe(1);
  });

  it('two identical payments in two camt.054 files: referenced ones both count, unreferenced ones are flagged', async () => {
    // With references: two separate payments.
    const a = await createOrder(1414);
    const b = await createOrder(1414);
    const one = await imp(
      'n1.xml',
      camtDoc('054', 'MSG-A1', [
        { amount: 1414, ref: 'BR-1', text: a.reference, iban: PAYER_IBAN },
      ]),
    );
    const two = await imp(
      'n2.xml',
      camtDoc('054', 'MSG-A2', [
        { amount: 1414, ref: 'BR-2', text: a.reference, iban: PAYER_IBAN },
      ]),
    );
    expect(one.importedCount).toBe(1);
    expect(two).toMatchObject({ importedCount: 1, duplicateCount: 0 });
    expect(await rowsOf(1414)).toHaveLength(2);
    expect((await orderRow(a.id)).status).toBe('PAID');
    void b;

    // Without references: the second looks like the first one – never dropped silently,
    // never matched, reported.
    const c = await createOrder(1415);
    const first = await imp(
      'm1.xml',
      camtDoc('054', 'MSG-B1', [{ amount: 1415, text: c.reference, iban: PAYER_IBAN }]),
    );
    expect(first.importedCount).toBe(1);
    expect((await orderRow(c.id)).status).toBe('PAID');
    const second = await imp(
      'm2.xml',
      camtDoc('054', 'MSG-B2', [{ amount: 1415, text: c.reference, iban: PAYER_IBAN }]),
    );
    expect(second).toMatchObject({ importedCount: 1, duplicateCount: 0, insertedIds: [] });
    expect(second.warnings.join(' ')).toMatch(/possible duplicate/);
    const flagged = (await rowsOf(1415)).find((r) => hold(r) === 'POSSIBLE_DUPLICATE')!;
    expect(flagged.matchStatus).toBe('IGNORED');
    expect(await paymentCount(c.id)).toBe(1);
    // An admin confirms it is a genuine second payment: released and matched (order is paid
    // already, so it becomes an overpayment case instead of being swallowed).
    const released = await rematchBankTransaction(ctx, flagged.id);
    expect(released.status).toBe('NEEDS_REVIEW');
    expect(
      hold(
        await handle.db
          .select()
          .from(bankTransactions)
          .where(eq(bankTransactions.id, flagged.id))
          .then((r) => r[0]!),
      ),
    ).toBeUndefined();
  });

  it('re-import of the same camt.054 file or message is idempotent', async () => {
    const order = await createOrder(1516);
    const bytes = camtDoc('054', 'MSG-C1', [
      { amount: 1516, ref: 'BR-C', text: order.reference, iban: PAYER_IBAN },
    ]);
    const first = await imp('c.xml', bytes);
    expect(first.importedCount).toBe(1);
    const same = await imp('c-again.xml', bytes);
    expect(same.status).toBe('DUPLICATE_FILE');
    // Same message, different bytes (new creation timestamp).
    const resent = await imp(
      'c-resent.xml',
      camtDoc(
        '054',
        'MSG-C1',
        [{ amount: 1516, ref: 'BR-C', text: order.reference, iban: PAYER_IBAN }],
        '2026-03-03T09:00:00',
      ),
    );
    expect(resent.status).toBe('DUPLICATE_FILE');
    expect(await rowsOf(1516)).toHaveLength(1);
    expect(await paymentCount(order.id)).toBe(1);
  });

  it('same reference id in a differently named notification is deduped by AcctSvcrRef + amount + IBAN', async () => {
    const order = await createOrder(1617);
    await imp(
      'd1.xml',
      camtDoc('054', 'MSG-D1', [
        { amount: 1617, ref: 'BR-D', text: order.reference, iban: PAYER_IBAN },
      ]),
    );
    const again = await imp(
      'd2.xml',
      camtDoc('054', 'MSG-D2', [
        { amount: 1617, ref: 'BR-D', text: order.reference, iban: PAYER_IBAN },
      ]),
    );
    expect(again).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    // Later the day statement carries it too (same AcctSvcrRef): still one row.
    const day = await imp(
      'd3.xml',
      camtDoc('053', 'STMT-D', [
        { amount: 1617, ref: 'BR-D', text: order.reference, iban: PAYER_IBAN },
      ]),
    );
    expect(day.importedCount).toBe(0);
    expect(await rowsOf(1617)).toHaveLength(1);
  });

  it('camt.054 without booking date: held unless it carries a reference', async () => {
    const a = await createOrder(1718);
    const held = await imp(
      'nb.xml',
      camtDoc('054', 'MSG-E1', [
        { amount: 1718, noBooking: true, val: '2026-03-05', text: a.reference, iban: PAYER_IBAN },
      ]),
    );
    expect(held).toMatchObject({ importedCount: 1, insertedIds: [] });
    expect(held.warnings.join(' ')).toMatch(/without booking date/);
    expect((await orderRow(a.id)).status).toBe('AWAITING_PAYMENT');
    const [row] = await rowsOf(1718);
    expect(hold(row!)).toBe('NO_BOOKING_DATE');
    // Releasing it by hand matches it.
    await rematchBankTransaction(ctx, row!.id);
    expect((await orderRow(a.id)).status).toBe('PAID');

    const b = await createOrder(1819);
    const withRef = await imp(
      'nb2.xml',
      camtDoc('054', 'MSG-E2', [
        {
          amount: 1819,
          noBooking: true,
          val: '2026-03-05',
          ref: 'BR-E',
          text: b.reference,
          iban: PAYER_IBAN,
        },
      ]),
    );
    expect(withRef.insertedIds).toHaveLength(1);
    expect((await orderRow(b.id)).status).toBe('PAID');
  });

  it('camt.054 per transaction, then the camt.053 batch entry: the money is counted once', async () => {
    const x = await createOrder(3000);
    const y = await createOrder(4000);
    await imp(
      'p1.xml',
      camtDoc('054', 'MSG-F1', [
        { amount: 3000, date: '2026-03-12', ref: 'BR-F1', text: x.reference, iban: PAYER_IBAN },
        { amount: 4000, date: '2026-03-12', ref: 'BR-F2', text: y.reference, iban: PAYER_IBAN },
      ]),
    );
    expect((await orderRow(x.id)).status).toBe('PAID');
    expect((await orderRow(y.id)).status).toBe('PAID');
    const agg = await imp(
      'day.xml',
      camtDoc('053', 'STMT-F', [
        { amount: 7000, date: '2026-03-12', details: [x.reference, y.reference] },
      ]),
    );
    expect(agg.insertedIds).toHaveLength(1);
    const [aggregate] = await rowsOf(7000);
    expect(hold(aggregate!)).toBe('AGGREGATE');
    expect(aggregate!.matchStatus).toBe('IGNORED');
    // Counted money = per-transaction rows only.
    const [sum] = await handle.db
      .select({ total: sql<number>`coalesce(sum(${bankTransactions.amount}), 0)::int` })
      .from(bankTransactions)
      .where(
        and(
          sql`${bankTransactions.bookingDate} = '2026-03-12'`,
          sql`${bankTransactions.rawData}->>'hold' is null`,
        ),
      );
    expect(sum?.total).toBe(7000);
  });

  it('camt.053 batch entry first, per-transaction camt.054 later', async () => {
    const x = await createOrder(5000);
    const y = await createOrder(6000);
    await imp(
      'day2.xml',
      camtDoc('053', 'STMT-G', [
        { amount: 11000, date: '2026-03-13', details: [x.reference, y.reference] },
      ]),
    );
    const before = (await rowsOf(11000))[0]!;
    expect(before.matchStatus).not.toBe('AUTO_MATCHED');
    await imp(
      'p2.xml',
      camtDoc('054', 'MSG-G1', [
        { amount: 5000, date: '2026-03-13', ref: 'BR-G1', text: x.reference, iban: PAYER_IBAN },
        { amount: 6000, date: '2026-03-13', ref: 'BR-G2', text: y.reference, iban: PAYER_IBAN },
      ]),
    );
    const aggregate = (await rowsOf(11000))[0]!;
    expect(hold(aggregate)).toBe('AGGREGATE');
    expect((await orderRow(x.id)).status).toBe('PAID');
    expect((await orderRow(y.id)).status).toBe('PAID');
  });
});
