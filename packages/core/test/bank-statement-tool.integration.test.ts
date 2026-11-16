/**
 * Proof for the payment-receipt load test tools (`scripts/load/bank-statement.mjs` and
 * `scripts/load/verify-reconciliation.mjs`) against the real engine: Vorkasse orders are created,
 * exported with the documented SQL (`scripts/load/open-orders.sql`), a statement is generated in
 * every format, imported through the real import pipeline, matched, and the database is read with
 * the verify tool's own queries and judged by its own evaluation function. The generator's
 * expectations must hold - if they do not, the generator is wrong (the engine is the source of
 * truth).
 *
 * Not covered here: invoices, tickets and payment e-mails are produced by the worker. The fixture
 * orders have no items, so the test checks that exactly one `order-paid` job is queued per PAID
 * order instead (the verify run against a real stack checks the results).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bankTransactions,
  createDb,
  customers,
  loadRootEnv,
  orders,
  systemSettings,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { buildPaymentReference, extractPaymentReferences } from '@tix/shared';
import { createSecretBox, parseKeyRing } from '@tix/shared/server';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreContext,
  importStatementFile,
  invalidateSettings,
  matchBankTransactions,
  parseCamt,
  parseCsv,
  parseMt940,
  saveBankAccount,
  type CoreContext,
  type JobQueues,
  type ObjectStorage,
} from '../src';
import { csvProfileSchema } from '@tix/shared';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const OWN_IBAN = 'DE89370400440532013000';
const TOLERANCE = 50;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mjs = any;
const loadTool = async (file: string): Promise<Mjs> =>
  import(
    /* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, '../../../scripts/load', file))
      .href
  );

describe.skipIf(!adminUrl || !redisUrl)('bank statement tools against the real engine', () => {
  // TIX_KEEP_TEST_DB=<name> keeps that database and writes <tmp>/<name>.<format>.expected.json, to try the CLI by hand.
  const keepDb = process.env.TIX_KEEP_TEST_DB;
  const dbName = keepDb || `tix_bst_${Date.now()}_${randomUUID().slice(0, 6)}`;
  let admin: pg.Client;
  let sql: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let ctx: CoreContext;
  let accountId: string;
  let customerId: string;
  let gen: Mjs;
  let verify: Mjs;
  const stored = new Map<string, Uint8Array>();
  const jobs: { queue: string; name: string; data: { orderId: string } }[] = [];

  const storage = {
    put: async (_b: string, key: string, body: Uint8Array | string) => {
      stored.set(key, typeof body === 'string' ? Buffer.from(body) : body);
    },
    get: async (_b: string, key: string) => ({ body: stored.get(key)!, contentType: undefined }),
    delete: async (_b: string, key: string) => {
      stored.delete(key);
    },
  } as unknown as ObjectStorage;

  /** The SELECT inside the documented `\copy (...) to stdout` of open-orders.sql. */
  const exportSelect = (): string => {
    const text = readFileSync(
      resolve(import.meta.dirname, '../../../scripts/load/open-orders.sql'),
      'utf8',
    );
    const m = /^\\copy \((.*)\) to stdout with csv header\s*$/s.exec(text.trim());
    if (!m) throw new Error('open-orders.sql has an unexpected shape');
    return m[1]!;
  };

  const csvEscape = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  /** Runs the export query like psql would and returns the CSV text. */
  async function exportOpenOrders(): Promise<string> {
    const res = await sql.query({ text: exportSelect(), rowMode: 'array' });
    const header = res.fields.map((f) => f.name).join(',');
    return [header, ...res.rows.map((r) => r.map(csvEscape).join(','))].join('\n') + '\n';
  }

  async function createOrders(batch: number, count: number): Promise<string> {
    const prefix = `B${batch}-`;
    for (let i = 1; i <= count; i += 1) {
      const reference = buildPaymentReference('TIX', 2026, String(100000 + batch * 1000 + i));
      const first = ['Anna', 'Jonas', 'Mia', 'Lukas', 'Emma', 'Paul', 'Sofia'][i % 7]!;
      await handle.db.insert(orders).values({
        orderNumber: `${prefix}${String(i).padStart(4, '0')}`,
        customerId,
        status: 'AWAITING_PAYMENT',
        channel: 'ONLINE',
        paymentMethod: 'BANK_TRANSFER',
        email: 'buyer@example.invalid',
        firstName: first,
        // Umlaut, comma and quote exercise the CSV export / import path.
        lastName: i % 9 === 0 ? `Müller-"Test", ${batch}x${i}` : `Beispiel${batch}x${i}`,
        locale: 'de',
        currency: 'EUR',
        subtotalGross: 2500 + i * 130,
        totalGross: 2500 + i * 130,
        totalNet: 2500 + i * 130,
        totalTax: 0,
        paymentReference: reference,
        paymentDueAt: new Date(Date.now() + 5 * 86_400_000),
      });
    }
    return prefix;
  }

  const lineText = (rows: Record<string, unknown>[]) =>
    rows.map((r) => String(Object.values(r)[0])).join('\n');

  async function snapshot(expected: Mjs) {
    const lines: string[] = [];
    for (const name of ['settings', 'transactions', 'orders', 'counts']) {
      const res = await sql.query({ text: verify.QUERIES[name](expected), rowMode: 'array' });
      lines.push(...res.rows.map((r) => String(r[0])));
    }
    const parsed = verify.parseMarkerLines(lines.join('\n')) as { kind: string; data: any }[];
    return {
      settings: parsed.find((l) => l.kind === 'settings')?.data,
      transactions: parsed.filter((l) => l.kind === 'tx').map((l) => l.data),
      orders: parsed.filter((l) => l.kind === 'order').map((l) => l.data),
      counts: parsed.find((l) => l.kind === 'counts')?.data,
    };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    if (keepDb) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    await runMigrations({
      connectionString: url.toString(),
      migrationsFolder: resolve(import.meta.dirname, '../../db/migrations'),
      log: () => {},
    });
    handle = createDb({ connectionString: url.toString(), poolMax: 10 });
    sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    const jobStub = {
      add: async (queue: string, name: string, data: { orderId: string }) => {
        jobs.push({ queue, name, data });
        return String(jobs.length);
      },
    } as unknown as JobQueues;
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix: `t${randomUUID().slice(0, 8)}`,
      sessionSecret: 'x'.repeat(48),
      secrets: createSecretBox(parseKeyRing(`k1:${randomBytes(32).toString('base64')}`)),
      storage,
      jobs: jobStub,
    });
    await handle.db.insert(systemSettings).values({
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
        autoMatchToleranceCents: TOLERANCE,
      },
    });
    invalidateSettings();
    const account = await saveBankAccount(ctx, null, {
      name: 'Main account',
      accountHolder: 'Example Club',
      iban: OWN_IBAN,
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
    gen = await loadTool('bank-statement.mjs');
    verify = await loadTool('verify-reconciliation.mjs');
  });

  afterAll(async () => {
    invalidateSettings();
    await sql?.end();
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (admin) {
      if (!keepDb) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  const formats: { format: string; splitFiles: number; seed: number }[] = [
    { format: 'camt053', splitFiles: 2, seed: 11 },
    { format: 'csv', splitFiles: 1, seed: 12 },
    { format: 'mt940', splitFiles: 1, seed: 13 },
  ];

  formats.forEach(({ format, splitFiles, seed }, index) => {
    it(`reconciles a generated ${format} statement exactly as expected (${splitFiles} file(s))`, async () => {
      const prefix = await createOrders(index + 1, 60);
      const exported = await exportOpenOrders();
      const all = gen.parseOrdersCsv(exported) as { orderNumber: string }[];
      const batch = all.filter((o) => o.orderNumber.startsWith(prefix));
      expect(batch).toHaveLength(60);
      const date = new Date().toISOString().slice(0, 10);
      const result = gen.generate(batch, {
        format,
        seed,
        date,
        splitFiles,
        toleranceCents: TOLERANCE,
        accountIban: OWN_IBAN,
        mix: gen.parseMix(undefined),
      });
      const expected = JSON.parse(JSON.stringify(result.expected));
      if (keepDb)
        writeFileSync(
          resolve(tmpdir(), `${dbName}.${format}.expected.json`),
          JSON.stringify(expected),
        );

      // Every reference text is found by the real tolerant extractor, valid and first.
      for (const e of result.plan.entries as {
        reference: string | null;
        text: string;
        endToEndId: string;
      }[]) {
        if (!e.reference) continue;
        // The engine searches the remittance text first (transactionReferences in matching.ts).
        const found = extractPaymentReferences(e.text, ['TIX']);
        expect(found[0], e.text).toMatchObject({ reference: e.reference, checksumValid: true });
        expect(found.filter((f) => f.checksumValid)).toHaveLength(1);
      }

      // The real parsers read each file and see exactly the planned bookings.
      for (const file of result.files as {
        name: string;
        content: string;
        transactions: number;
      }[]) {
        const parsed =
          format === 'camt053'
            ? parseCamt(file.content)
            : format === 'mt940'
              ? parseMt940(file.content)
              : parseCsv(file.content, csvProfileSchema.parse({}), 'EUR');
        expect(parsed.warnings).toEqual([]);
        const txs = parsed.statements.flatMap((s) => s.transactions);
        expect(txs).toHaveLength(file.transactions);
        expect(parsed.statements[0]!.accountIdentifier).toBe(OWN_IBAN);
        for (const t of txs) {
          expect(t.endToEndId).toMatch(/^KT[A-Z0-9]{5}-\d{5}$/);
          expect(t.counterpartyIban).toMatch(/^DE\d{20}$/);
          expect(t.bookingDate).toBe(date);
        }
      }

      // Import every file through the real pipeline and run the matcher on the new credits.
      const before = jobs.length;
      let credits = 0;
      for (const file of result.files as { name: string; content: string }[]) {
        const [imported] = await importStatementFile(ctx, {
          account: { id: accountId, iban: OWN_IBAN, currency: 'EUR' },
          source: 'UPLOAD',
          fileName: file.name.split(/[\\/]/).pop()!,
          bytes: new Uint8Array(Buffer.from(file.content, 'utf8')),
        });
        expect(imported!.status, imported!.errorMessage ?? '').toBe('COMPLETED');
        expect(imported!.duplicateCount).toBe(0);
        credits += imported!.insertedIds.length;
        await matchBankTransactions(ctx, imported!.insertedIds);
      }
      expect(credits).toBe(expected.totals.credits);

      // The verify tool's queries + evaluation agree with the generator's expectation.
      const snap = await snapshot(expected);
      expect(snap.counts.tx).toBeDefined();
      const verdict = verify.evaluate(snap, expected, { fulfillment: false });
      expect(verdict.checks.filter((c: { failed: number }) => c.failed > 0)).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(snap.orders.filter((o: { status: string }) => o.status === 'PAID')).toHaveLength(
        expected.totals.ordersExpectedPaid,
      );
      expect(snap.settings.toleranceCents).toBe(TOLERANCE);

      // One order-paid job per PAID order (fulfilment is the worker's job).
      const queued = jobs.slice(before).filter((j) => j.name === 'order-paid');
      expect(new Set(queued.map((j) => j.data.orderId)).size).toBe(
        expected.totals.ordersExpectedPaid,
      );
      expect(queued).toHaveLength(expected.totals.ordersExpectedPaid);

      // Review cases by reason, straight from the engine.
      const rows = await handle.db
        .select()
        .from(bankTransactions)
        .where(eq(bankTransactions.matchStatus, 'NEEDS_REVIEW'));
      const reasons = (r: { endToEndId: string | null }) =>
        r.endToEndId?.startsWith(`${expected.e2ePrefix}${expected.runId}-`);
      const byReason: Record<string, number> = {};
      for (const r of rows.filter(reasons))
        byReason[r.reviewReason!] = (byReason[r.reviewReason!] ?? 0) + 1;
      expect(byReason).toEqual({
        UNDERPAYMENT: expected.scenarios.underBeyond.orders,
        OVERPAYMENT: expected.scenarios.over.orders + expected.scenarios.duplicate.orders,
        UNKNOWN_REFERENCE: expected.scenarios.unknown.orders,
        NAME_MATCH_ONLY: expected.scenarios.nameOnly.orders,
      });
    });
  });

  it('reads a hyphen-less reference followed by an id starting with a digit look-alike', () => {
    const ref = buildPaymentReference('TIX', 2026, '100057');
    const typed = ref.replace(/-/g, '');
    // Fixed in the extractor (token boundaries); the generator's `KT` ids stay harmless.
    for (const id of ['LTABCDE-00001', 'KTABCDE-00001', 'NOTPROVIDED', 'D4711000123']) {
      expect(extractPaymentReferences(`${typed} ${id}`, ['TIX'])[0]!.reference, id).toBe(ref);
    }
  });

  it('the evaluation notices a wrong outcome', async () => {
    const expected = JSON.parse(
      JSON.stringify(
        gen.generate(
          [
            {
              reference: buildPaymentReference('TIX', 2026, '777001'),
              amountCents: 5000,
              currency: 'EUR',
              payerName: 'Max Muster',
              orderNumber: 'NEG-1',
            },
          ],
          { mix: gen.parseMix('exact=100'), seed: 5, toleranceCents: TOLERANCE },
        ).expected,
      ),
    );
    const verdict = verify.evaluate(
      {
        transactions: [],
        orders: [
          {
            orderNumber: 'NEG-1',
            status: 'AWAITING_PAYMENT',
            totalGross: 5000,
            amountPaid: 0,
            items: 0,
            captured: 0,
            capturedCents: 0,
            bankCapturedCents: 0,
            allocations: 0,
            allocatedCents: 0,
            invoices: 0,
            tickets: 0,
            paymentMails: 0,
          },
        ],
      },
      expected,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toBeGreaterThan(0);
  });
});
