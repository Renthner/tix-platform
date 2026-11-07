/**
 * Invoices, e-mail rendering and the outbox against real PostgreSQL, Redis (BullMQ) and the
 * S3 object storage of the dev stack: gapless numbers, GoBD immutability, PDF archive,
 * template fallback, idempotent paid-order fulfilment and delivery via a test transport.
 * All data lives in a throw-away database / Redis prefix; stored PDFs are deleted again.
 */
import { randomUUID } from 'node:crypto';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { resolve } from 'node:path';
import {
  bankAccounts,
  createDb,
  customers,
  emailMessages,
  emailTemplates,
  events,
  invoiceLines,
  invoices,
  loadRootEnv,
  numberSequences,
  orderFees,
  orderHistory,
  orderItems,
  orders,
  priceCategories,
  seatMapSections,
  seatMaps,
  taxRates,
  ticketTypes,
  venues,
  type DbHandle,
} from '@tix/db';
import { runMigrations } from '@tix/db/migrate';
import { seedReferenceData } from '@tix/db/seed';
import { EMAIL_TEMPLATE_KEYS, buildPaymentReference, splitGross } from '@tix/shared';
import { createSecretBox, generateKeyRingEntry, parseKeyRing } from '@tix/shared/server';
import { and, eq, like, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createTransport } from 'nodemailer';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  EmailDeliveryError,
  JobQueues,
  createCoreContext,
  createEmailMessage,
  deliverEmailMessage,
  enqueueEmail,
  formatMoney,
  issueInvoice,
  loadInvoicePdf,
  objectStorageFromEnv,
  processPaidOrder,
  renderEmail,
  renderInvoicePdf,
  requeueStaleEmails,
  saveSetting,
  sendTestEmail,
  type CoreContext,
  type MailSender,
} from '../src';

loadRootEnv();
const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const s3Endpoint = process.env.S3_ENDPOINT;
const uuid = () => randomUUID();

/** Test transport: nodemailer renders the full MIME message as JSON instead of sending it. */
function jsonSender(): MailSender & { sent: Record<string, unknown>[] } {
  const transporter = createTransport({ jsonTransport: true });
  const sent: Record<string, unknown>[] = [];
  const original = transporter.sendMail.bind(transporter);
  transporter.sendMail = (async (mail: Parameters<typeof original>[0]) => {
    const info = (await original(mail)) as { message: string; messageId: string };
    sent.push(JSON.parse(info.message) as Record<string, unknown>);
    return info;
  }) as typeof transporter.sendMail;
  return {
    transporter,
    from: { name: 'Example Theatre', address: 'tickets@example.org' },
    replyTo: 'help@example.org',
    sent,
  };
}

/**
 * The documents bucket is versioned, so deleting with the app user only adds delete markers.
 * Test PDFs are purged completely (all versions) with the storage root credentials.
 */
async function purgeTestObjects(prefix: string): Promise<void> {
  const { MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, S3_BUCKET_DOCUMENTS } = process.env;
  if (!MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD || !S3_BUCKET_DOCUMENTS) return;
  const client = new S3Client({
    endpoint: s3Endpoint,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_ROOT_USER, secretAccessKey: MINIO_ROOT_PASSWORD },
  });
  const listed = await client.send(
    new ListObjectVersionsCommand({ Bucket: S3_BUCKET_DOCUMENTS, Prefix: prefix }),
  );
  const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((v) => ({
    Key: v.Key!,
    VersionId: v.VersionId,
  }));
  if (objects.length > 0) {
    await client.send(
      new DeleteObjectsCommand({ Bucket: S3_BUCKET_DOCUMENTS, Delete: { Objects: objects } }),
    );
  }
  client.destroy();
}

function failingSender(error: Error): MailSender {
  return {
    transporter: {
      sendMail: async () => {
        throw error;
      },
    } as unknown as MailSender['transporter'],
    from: { name: 'Example Theatre', address: 'tickets@example.org' },
  };
}

describe.skipIf(!adminUrl || !redisUrl || !s3Endpoint)('invoices & e-mail (integration)', () => {
  const dbName = `tix_docs_${Date.now()}_${uuid().slice(0, 6)}`;
  const tag = `T${uuid().slice(0, 4).toUpperCase()}`;
  const year = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Europe/Berlin' }).format(
    new Date(),
  );
  let admin: pg.Client;
  let handle: DbHandle;
  let redis: Redis;
  let bullRedis: Redis;
  let jobs: JobQueues;
  let ctx: CoreContext;
  const storedKeys = new Set<string>();

  let event7: string;
  let event0: string;
  let sectionId: string;
  let categoryId: string;
  let ticketTypeId: string;
  let orderSeq = 0;

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
    await seedReferenceData(handle.db, () => {});
    redis = new Redis(redisUrl!, { enableAutoPipelining: true });
    bullRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const keyPrefix = `t${uuid().slice(0, 8)}`;
    jobs = new JobQueues(bullRedis, `${keyPrefix}:bull`);
    ctx = createCoreContext({
      db: handle.db,
      redis,
      publisher: redis,
      keyPrefix,
      sessionSecret: 'x'.repeat(48),
      appUrl: 'https://shop.example.org/',
      secrets: createSecretBox(parseKeyRing(generateKeyRingEntry('t1'))),
      storage: objectStorageFromEnv(
        process.env as unknown as Parameters<typeof objectStorageFromEnv>[0],
      ),
      jobs,
    });

    await saveSetting(
      ctx,
      'general',
      {
        shopName: 'Example Theatre Tickets',
        defaultLocale: 'en',
        defaultCurrency: 'EUR',
        defaultTimeZone: 'Europe/Berlin',
        supportEmail: 'help@example.org',
      },
      null,
    );
    await saveSetting(
      ctx,
      'organizer',
      {
        legalName: 'Example Theatre e.V.',
        street: 'Musterweg 1',
        postalCode: '12345',
        city: 'Musterstadt',
        country: 'DE',
        taxNumber: '000/000/00000',
        email: 'info@example.org',
      },
      null,
    );
    // Unique prefix: the stored PDFs share the dev stack's documents bucket.
    await saveSetting(ctx, 'invoicing', { invoiceNumberPattern: `${tag}-{YYYY}-{SEQ:4}` }, null);

    await handle.db.insert(bankAccounts).values({
      name: 'Main account',
      accountHolder: 'Example Theatre e.V.',
      iban: 'DE89370400440532013000',
      bic: 'TESTDEFFXXX',
      bankName: 'Example Bank',
      currency: 'EUR',
      isDefaultForBankTransfer: true,
    });

    const rates = await handle.db.select().from(taxRates);
    const rate7 = rates.find((r) => r.rateBasisPoints === 700)!;
    const rate0 = rates.find((r) => r.rateBasisPoints === 0 && r.invoiceNote?.includes('§ 19'))!;
    const [venue] = await handle.db
      .insert(venues)
      .values({
        name: 'Stadthalle',
        slug: 'stadthalle',
        city: 'Musterstadt',
        timeZone: 'Europe/Berlin',
      })
      .returning();
    const [map] = await handle.db
      .insert(seatMaps)
      .values({
        venueId: venue!.id,
        kind: 'EVENT',
        name: 'Hall',
        canvasWidth: 100,
        canvasHeight: 100,
      })
      .returning();
    const [section] = await handle.db
      .insert(seatMapSections)
      .values({
        seatMapId: map!.id,
        type: 'STANDING',
        name: 'Floor',
        ticketLabel: 'Floor',
        capacity: 500,
        geometry: { type: 'rect', x: 0, y: 0, width: 50, height: 50, rotation: 0 },
      })
      .returning();
    sectionId = section!.id;
    const insertEvent = async (
      title: string,
      taxRateId: string,
      days: number,
      seatMapId: string | null,
    ) => {
      const [ev] = await handle.db
        .insert(events)
        .values({
          venueId: venue!.id,
          seatMapId,
          slug: `ev-${uuid().slice(0, 8)}`,
          title,
          startsAt: new Date(Date.now() + days * 86_400_000),
          timeZone: 'Europe/Berlin',
          currency: 'EUR',
          taxRateId,
        })
        .returning();
      return ev!.id;
    };
    event7 = await insertEvent('Winter Gala', rate7.id, 30, map!.id);
    event0 = await insertEvent('Spring Matinee', rate0.id, 60, null);
    const [category] = await handle.db
      .insert(priceCategories)
      .values({ eventId: event7, name: 'Cat 1', color: '#336699', basePrice: 3210 })
      .returning();
    categoryId = category!.id;
    const [tt] = await handle.db
      .insert(ticketTypes)
      .values({ eventId: event7, name: 'Normal', isDefault: true })
      .returning();
    ticketTypeId = tt!.id;
  });

  afterAll(async () => {
    for (const key of storedKeys) await ctx?.storage?.delete('documents', key).catch(() => {});
    await purgeTestObjects(`invoices/${year}/${tag}-`);
    await jobs?.close();
    await handle?.close();
    if (redis) {
      const keys = await redis.keys(`${ctx.keys.prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    await bullRedis?.quit();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  interface ItemSpec {
    eventId: string;
    price: number;
    rate: number;
  }

  async function insertOrder(opts: {
    items: ItemSpec[];
    fees?: { name: string; amount: number; rate: number }[];
    locale?: string;
    firstName?: string;
    status?: 'PAID' | 'AWAITING_PAYMENT';
    paymentMethod?: 'PAYPAL' | 'BANK_TRANSFER';
  }) {
    orderSeq += 1;
    const email = `buyer${orderSeq}-${uuid().slice(0, 6)}@example.org`;
    const [customer] = await handle.db
      .insert(customers)
      .values({ email, firstName: opts.firstName ?? 'Ann', lastName: 'Example' })
      .returning();
    const subtotal = opts.items.reduce((s, i) => s + i.price, 0);
    const feeTotal = (opts.fees ?? []).reduce((s, f) => s + f.amount, 0);
    const split = [
      ...opts.items.map((i) => splitGross(i.price, i.rate)),
      ...(opts.fees ?? []).map((f) => splitGross(f.amount, f.rate)),
    ];
    const status = opts.status ?? 'PAID';
    const total = subtotal + feeTotal;
    const [order] = await handle.db
      .insert(orders)
      .values({
        orderNumber: `${tag}-O${orderSeq}`,
        customerId: customer!.id,
        status,
        channel: 'ONLINE',
        paymentMethod: opts.paymentMethod ?? 'PAYPAL',
        email,
        firstName: opts.firstName ?? 'Ann',
        lastName: 'Example',
        billingAddress: {
          street: 'Hauptstraße 5',
          postalCode: '54321',
          city: 'Beispielhausen',
          country: 'DE',
        },
        locale: opts.locale ?? 'en',
        currency: 'EUR',
        subtotalGross: subtotal,
        feeTotal,
        totalGross: total,
        totalNet: split.reduce((s, x) => s + x.net, 0),
        totalTax: split.reduce((s, x) => s + x.tax, 0),
        amountPaid: status === 'PAID' ? total : 0,
        paidAt: status === 'PAID' ? new Date() : null,
        ...(status === 'AWAITING_PAYMENT'
          ? {
              paymentReference: buildPaymentReference('TIX', Number(year), String(1000 + orderSeq)),
              paymentDueAt: new Date(Date.now() + 5 * 86_400_000),
            }
          : {}),
      })
      .returning();
    await handle.db.insert(orderItems).values(
      opts.items.map((item, n) => {
        const { net, tax } = splitGross(item.price, item.rate);
        return {
          orderId: order!.id,
          eventId: item.eventId,
          kind: 'GENERAL_ADMISSION' as const,
          sectionId,
          priceCategoryId: categoryId,
          ticketTypeId,
          status: status === 'PAID' ? ('CONFIRMED' as const) : ('PENDING' as const),
          sectionLabel: `Floor ${n + 1}`,
          categoryName: 'Cat 1',
          ticketTypeName: 'Normal',
          unitPriceGross: item.price,
          priceGross: item.price,
          taxRateBasisPoints: item.rate,
          priceNet: net,
          taxAmount: tax,
        };
      }),
    );
    if (opts.fees?.length) {
      await handle.db.insert(orderFees).values(
        opts.fees.map((f) => {
          const { net, tax } = splitGross(f.amount, f.rate);
          return {
            orderId: order!.id,
            name: f.name,
            scope: 'PER_ORDER' as const,
            quantity: 1,
            unitAmountGross: f.amount,
            totalGross: f.amount,
            taxRateBasisPoints: f.rate,
            totalNet: net,
            totalTax: tax,
          };
        }),
      );
    }
    return order!;
  }

  it('seeds every default template once and never overwrites admin edits', async () => {
    const rows = await handle.db.select().from(emailTemplates);
    expect(rows).toHaveLength(EMAIL_TEMPLATE_KEYS.length * 2);
    await handle.db
      .update(emailTemplates)
      .set({ subject: 'Edited by admin' })
      .where(and(eq(emailTemplates.key, 'SMTP_TEST'), eq(emailTemplates.locale, 'en')));
    await seedReferenceData(handle.db, () => {});
    const after = await handle.db.select().from(emailTemplates);
    expect(after).toHaveLength(rows.length);
    expect(after.find((r) => r.key === 'SMTP_TEST' && r.locale === 'en')?.subject).toBe(
      'Edited by admin',
    );
  });

  let invoiceA: { invoiceId: string; invoiceNumber: string };
  let orderA: { id: string };

  it('issues gapless invoices with lines, tax breakdown and legal notes (idempotent)', async () => {
    orderA = await insertOrder({
      items: [
        { eventId: event7, price: 3210, rate: 700 },
        { eventId: event7, price: 2710, rate: 700 },
        { eventId: event0, price: 1500, rate: 0 },
      ],
      fees: [{ name: 'Service fee', amount: 119, rate: 1900 }],
    });
    invoiceA = (await issueInvoice(ctx, orderA.id))!;
    expect(invoiceA.invoiceNumber).toBe(`${tag}-${year}-0001`);
    expect(await issueInvoice(ctx, orderA.id)).toEqual(invoiceA);

    const [invoice] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceA.invoiceId));
    const lines = await handle.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceA.invoiceId));
    expect(lines).toHaveLength(4);
    expect(lines.reduce((s, l) => s + l.totalGross, 0)).toBe(invoice!.totalGross);
    expect(invoice!.totalGross).toBe(3210 + 2710 + 1500 + 119);
    expect(invoice!.totalNet + invoice!.totalTax).toBe(invoice!.totalGross);
    expect(invoice!.taxBreakdown.map((b) => b.rateBasisPoints)).toEqual([1900, 700, 0]);
    expect(invoice!.taxBreakdown.find((b) => b.rateBasisPoints === 0)?.note).toMatch(/§ 19 UStG/);
    expect(invoice!.legalNotes).toMatch(/§ 19 UStG/);
    expect(invoice!.legalNotes).toMatch(/date of supply/);
    expect(invoice!.seller).toMatchObject({
      name: 'Example Theatre e.V.',
      taxNumber: '000/000/00000',
    });
    expect(invoice!.buyer).toMatchObject({ name: 'Ann Example' });
    const ticketLine = lines.find((l) => l.position === 1)!;
    expect(ticketLine.description).toBe('Winter Gala\nStanding area · Floor 1 · Cat 1 · Normal');
    expect(ticketLine.serviceDate).toBeInstanceOf(Date);
    const history = await handle.db
      .select()
      .from(orderHistory)
      .where(and(eq(orderHistory.orderId, orderA.id), eq(orderHistory.type, 'invoice_issued')));
    expect(history).toHaveLength(1);

    // Concurrent issuance for another order: exactly one invoice, next number without gap.
    const orderB = await insertOrder({ items: [{ eventId: event7, price: 3210, rate: 700 }] });
    const results = await Promise.all([1, 2, 3].map(() => issueInvoice(ctx, orderB.id)));
    expect(new Set(results.map((r) => r!.invoiceId)).size).toBe(1);
    expect(results[0]!.invoiceNumber).toBe(`${tag}-${year}-0002`);
    const forB = await handle.db.select().from(invoices).where(eq(invoices.orderId, orderB.id));
    expect(forB).toHaveLength(1);
  });

  it('does not invoice unpaid orders and never consumes a number for them', async () => {
    const unpaid = await insertOrder({
      items: [{ eventId: event7, price: 3210, rate: 700 }],
      status: 'AWAITING_PAYMENT',
      paymentMethod: 'BANK_TRANSFER',
    });
    await expect(issueInvoice(ctx, unpaid.id)).rejects.toMatchObject({ code: 'ORDER_NOT_PAID' });
    const [seq] = await handle.db
      .select()
      .from(numberSequences)
      .where(like(numberSequences.scope, `invoice:${tag}%`));
    expect(seq!.lastValue).toBe(2);
  });

  it('keeps issued invoices immutable (GoBD trigger)', async () => {
    await expect(
      handle.db.update(invoices).set({ totalGross: 1 }).where(eq(invoices.id, invoiceA.invoiceId)),
    ).rejects.toThrow();
    await expect(
      handle.db.delete(invoices).where(eq(invoices.id, invoiceA.invoiceId)),
    ).rejects.toThrow();
    await expect(
      handle.db
        .update(invoiceLines)
        .set({ description: 'x' })
        .where(eq(invoiceLines.invoiceId, invoiceA.invoiceId)),
    ).rejects.toThrow();
  });

  it('renders the PDF once, archives it and reproduces it identically', async () => {
    const { objectKey } = await renderInvoicePdf(ctx, invoiceA.invoiceId);
    storedKeys.add(objectKey);
    expect(objectKey).toBe(`invoices/${year}/${tag}-${year}-0001.pdf`);
    const [row] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceA.invoiceId));
    expect(row!.pdfObjectKey).toBe(objectKey);

    const first = await loadInvoicePdf(ctx, invoiceA.invoiceId);
    expect(Buffer.from(first.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(first.fileName).toBe(`Invoice-${tag}-${year}-0001.pdf`);

    // Lost object → rendered again from the immutable data, byte-identical.
    await ctx.storage!.delete('documents', objectKey);
    const again = await loadInvoicePdf(ctx, invoiceA.invoiceId);
    expect(Buffer.from(again.bytes).equals(Buffer.from(first.bytes))).toBe(true);

    // The archived key itself can never be swapped.
    await expect(
      handle.db
        .update(invoices)
        .set({ pdfObjectKey: 'invoices/other.pdf' })
        .where(eq(invoices.id, invoiceA.invoiceId)),
    ).rejects.toThrow();
  });

  it('renders order e-mails with the standard variables, escaping and locale/event fallback', async () => {
    const order = await insertOrder({
      items: [{ eventId: event7, price: 3210, rate: 700 }],
      status: 'AWAITING_PAYMENT',
      paymentMethod: 'BANK_TRANSFER',
      locale: 'de',
      firstName: '<Jürgen>',
    });
    const [stored] = await handle.db.select().from(orders).where(eq(orders.id, order.id));
    const de = await renderEmail(ctx, {
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      orderId: order.id,
    });
    expect(de.locale).toBe('de');
    expect(de.to).toBe(stored!.email);
    expect(de.subject).toBe(
      `Ihre Bestellung ${stored!.orderNumber} – bitte überweisen Sie ${formatMoney(3210, 'EUR', 'de')}`,
    );
    expect(de.html).toContain('Hallo &lt;Jürgen&gt;,');
    expect(de.html).not.toContain('<Jürgen>');
    expect(de.text).toContain('Hallo <Jürgen>,');
    for (const expected of [
      'DE89 3704 0044 0532 0130 00',
      'TESTDEFFXXX',
      'Example Theatre e.V.',
      stored!.paymentReference!,
      'Winter Gala',
      `https://shop.example.org/de/orders/${stored!.orderNumber}?t=`,
    ]) {
      expect(de.text, expected).toContain(expected);
    }
    expect(de.missing).toEqual([]);

    // Event-specific override wins for its locale; other locales fall back to the shop default.
    await handle.db.insert(emailTemplates).values({
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      eventId: event7,
      locale: 'de',
      subject: 'Override {{orderNumber}} {{eventTitle}}',
      bodyHtml: '<p>{{firstName}}</p>',
    });
    const override = await renderEmail(ctx, {
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      orderId: order.id,
    });
    expect(override.subject).toBe(`Override ${stored!.orderNumber} Winter Gala`);
    expect(override.text).toBe('<Jürgen>'); // generated from the HTML body
    const fr = await renderEmail(ctx, {
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      orderId: order.id,
      locale: 'fr',
    });
    expect(fr.locale).toBe('en');
    expect(fr.subject).toMatch(/^Your order /);
    // Inactive templates are ignored.
    await handle.db
      .update(emailTemplates)
      .set({ isActive: false })
      .where(eq(emailTemplates.eventId, event7));
    const inactive = await renderEmail(ctx, {
      key: 'ORDER_CONFIRMATION_BANK_TRANSFER',
      orderId: order.id,
    });
    expect(inactive.subject).toMatch(/^Ihre Bestellung/);
  });

  it('fulfils a paid order once: invoice + payment e-mail with the PDF attached', async () => {
    const order = await insertOrder({
      items: [{ eventId: event7, price: 3210, rate: 700 }],
      locale: 'de',
    });
    const first = await processPaidOrder(ctx, order.id);
    expect(first.invoiceId).toBeTruthy();
    expect(first.messageId).toBeTruthy();
    const job = await jobs.queue('email').getJob(`email-${first.messageId}`);
    expect(job?.data).toEqual({ messageId: first.messageId });
    const second = await processPaidOrder(ctx, order.id);
    expect(second).toMatchObject({ invoiceId: first.invoiceId, messageId: null });
    const messages = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.orderId, order.id));
    expect(messages).toHaveLength(1);

    const sender = jsonSender();
    const result = await deliverEmailMessage(ctx, first.messageId!, { sender });
    expect(result.status).toBe('SENT');
    const [invoice] = await handle.db
      .select()
      .from(invoices)
      .where(eq(invoices.id, first.invoiceId!));
    storedKeys.add(invoice!.pdfObjectKey!);
    const mail = sender.sent[0]!;
    expect(mail.subject).toBe(`Zahlung erhalten – Ihre Bestellung ${tag}-O${orderSeq}`);
    expect(String(mail.html)).toContain(`Ihre Rechnung ${invoice!.invoiceNumber}`);
    expect(mail.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated' });
    const attachments = mail.attachments as { filename: string; contentType: string }[];
    expect(attachments).toEqual([
      expect.objectContaining({
        filename: `Rechnung-${invoice!.invoiceNumber}.pdf`,
        contentType: 'application/pdf',
      }),
    ]);
    const [row] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, first.messageId!));
    expect(row).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
    expect(row!.subject).toBe(mail.subject);
    expect(row!.sentAt).toBeInstanceOf(Date);
    expect(await deliverEmailMessage(ctx, first.messageId!, { sender })).toEqual({
      status: 'ALREADY_SENT',
    });
    expect(sender.sent).toHaveLength(1);
  });

  it('stores extra variables encrypted and renders account e-mails', async () => {
    const resetUrl = 'https://shop.example.org/en/account/reset?token=secret-token-123';
    const { messageId } = await enqueueEmail(ctx, {
      key: 'CUSTOMER_PASSWORD_RESET',
      to: 'someone@example.org',
      locale: 'en',
      variables: { resetUrl, firstName: 'Sam' },
    });
    const [row] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    expect(JSON.stringify(row!.attachments)).not.toContain('secret-token-123');
    expect(row!.jobId).toBe(`email-${messageId}`);
    const sender = jsonSender();
    await deliverEmailMessage(ctx, messageId, { sender });
    expect(String(sender.sent[0]!.text)).toContain(resetUrl);
    expect(String(sender.sent[0]!.text)).toContain('Hello Sam,');
    expect(sender.sent[0]!.subject).toBe('Reset your password for Example Theatre Tickets');
  });

  it('re-queues transient failures, fails on the last attempt and on permanent errors', async () => {
    const messageId = await createEmailMessage(ctx, ctx.db, {
      key: 'SMTP_TEST',
      to: 'a@example.org',
    });
    const transient = failingSender(new Error('connect ECONNREFUSED'));
    await expect(deliverEmailMessage(ctx, messageId, { sender: transient })).rejects.toMatchObject({
      permanent: false,
    });
    let [row] = await handle.db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'connect ECONNREFUSED' });
    await expect(
      deliverEmailMessage(ctx, messageId, { sender: transient, finalAttempt: true }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    [row] = await handle.db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(row).toMatchObject({ status: 'FAILED', attempts: 2 });

    // Recipient rejected by the server → permanent.
    const rejected = await createEmailMessage(ctx, ctx.db, {
      key: 'SMTP_TEST',
      to: 'b@example.org',
    });
    const smtpError = Object.assign(new Error('550 mailbox unavailable'), {
      responseCode: 550,
      command: 'RCPT TO',
    });
    await expect(
      deliverEmailMessage(ctx, rejected, { sender: failingSender(smtpError) }),
    ).rejects.toMatchObject({ permanent: true });

    // No active template → permanent.
    await handle.db
      .update(emailTemplates)
      .set({ isActive: false })
      .where(eq(emailTemplates.key, 'TICKETS_RESENT'));
    const noTemplate = await createEmailMessage(ctx, ctx.db, {
      key: 'TICKETS_RESENT',
      to: 'c@example.org',
    });
    await expect(
      deliverEmailMessage(ctx, noTemplate, { sender: jsonSender() }),
    ).rejects.toMatchObject({ permanent: true });
    [row] = await handle.db.select().from(emailMessages).where(eq(emailMessages.id, noTemplate));
    expect(row!.status).toBe('FAILED');
    await handle.db
      .update(emailTemplates)
      .set({ isActive: true })
      .where(eq(emailTemplates.key, 'TICKETS_RESENT'));
  });

  it('rejects invalid recipients when queueing', async () => {
    await expect(
      createEmailMessage(ctx, ctx.db, { key: 'SMTP_TEST', to: 'not-an-address' }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('reports a missing SMTP configuration on the test e-mail', async () => {
    const result = await sendTestEmail(ctx, { to: 'admin@example.org' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/SMTP is not configured/);
    const [row] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, result.messageId!));
    expect(row!.status).toBe('FAILED');
  });

  it('re-dispatches stored messages whose job never reached the queue', async () => {
    const messageId = await createEmailMessage(ctx, ctx.db, {
      key: 'SMTP_TEST',
      to: 'd@example.org',
    });
    await handle.db
      .update(emailMessages)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(emailMessages.id, messageId));
    expect(await requeueStaleEmails(ctx)).toBeGreaterThanOrEqual(1);
    const [row] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    expect(row!.jobId).toMatch(new RegExp(`^email-${messageId}-`));
    const job = await jobs.queue('email').getJob(row!.jobId!);
    expect(job?.data).toEqual({ messageId });
    // A message whose job is still waiting is left alone.
    await handle.db
      .update(emailMessages)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(emailMessages.id, messageId));
    const before = row!.jobId;
    await requeueStaleEmails(ctx);
    const [same] = await handle.db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.id, messageId));
    expect(same!.jobId).toBe(before);
  });
});
