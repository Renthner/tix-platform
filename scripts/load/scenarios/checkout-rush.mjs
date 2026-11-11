// Scenario 3 - checkout rush: users pick seats / standing spots at the same moment and every
// user who got something places a bank-transfer (Vorkasse) order concurrently. Some users
// double-submit the checkout. Afterwards orders, items, references and inventory are reconciled.
//
// WARNING: this scenario creates real orders (and e-mail outbox rows) on the target.
import { pick, rng, shuffle } from '../lib/common.mjs';
import { checkDatabase, checkSeatLocks, readRedisState } from '../lib/invariants.mjs';
import { Ledger, prepareVus, releaseTogether } from '../lib/rush.mjs';

export const name = 'checkout-rush';

export async function run(ctx) {
  const { cfg, world, eventId, report, db } = ctx;
  const runId = Date.now().toString(36);
  const email = (i) => `load-${runId}-${i}@example.invalid`;
  const ledger = new Ledger(); // seats currently locked / ordered per VU (from HTTP answers)
  const orders = new Map(); // vu -> {orderNumber, items, total, seats[], ga}
  const counters = {
    withItems: 0,
    noSeats: 0,
    ordersCreated: 0,
    checkoutRejected: 0,
    doubleSubmits: 0,
    doubleSubmitBothOk: 0,
    orderPagesRead: 0,
  };
  const { vus, warm, rush } = await prepareVus(ctx);
  const seatCats = world.categories.filter((c) => world.map.seats.some((s) => s.c === c.id));
  const gaByVu = new Map();
  const attempts = new Map(); // vu -> what it tried to order and how the server answered

  const durationMs = await releaseTogether(vus, rush, async (vu, i) => {
    const rand = rng(cfg.seed * 15485863 + i);
    const wanted = 1 + Math.floor(rand() * 3);
    const mine = [];
    if (rand() < 0.3) {
      const r = await vu.call('BEST_AVAILABLE', 'POST', `/api/events/${eventId}/best-available`, {
        categoryId: pick(rand, seatCats).id,
        quantity: Math.max(2, wanted),
      });
      if (r.status === 200) for (const s of r.body.seatIds) mine.push(s);
    } else {
      const order = shuffle(rand, world.coldSeats.concat(world.hotSeats)).slice(0, 12);
      for (const seat of order) {
        if (mine.length >= wanted) break;
        const r = await vu.call('LOCK_RANDOM', 'POST', `/api/events/${eventId}/seats`, {
          seatIds: [seat],
        });
        if (r.status === 200) mine.push(seat);
      }
    }
    for (const s of mine) ledger.add(s, vu.id);
    let ga = 0;
    if (world.ga && rand() < 0.3) {
      const q = 1 + Math.floor(rand() * 2);
      const r = await vu.call('GA_HOLD', 'PUT', `/api/events/${eventId}/general-admission`, {
        sectionId: world.ga.id,
        quantity: q,
      });
      if (r.status === 200) ga = q;
    }
    gaByVu.set(vu.id, ga);
    if (mine.length + ga === 0) return void counters.noSeats++;
    counters.withItems++;

    const cart = (await vu.call('CART', 'GET', '/api/cart')).body;
    if (!cart || cart.itemCount !== mine.length + ga) {
      counters.cartMismatch = (counters.cartMismatch ?? 0) + 1;
      return;
    }
    const payload = {
      method: 'BANK_TRANSFER',
      email: email(i),
      firstName: 'Load',
      lastName: `Tester ${i}`,
      phone: '+49 30 1234567',
      address: { street: 'Teststrasse 1', postalCode: '10115', city: 'Berlin', country: 'DE' },
      acceptTerms: true,
      expectedTotalGross: cart.totalGross,
      locale: 'en',
    };
    const double = rand() < 0.05;
    const attempt = { email: payload.email, seats: [...mine], ga, statuses: [] };
    attempts.set(vu.id, attempt);
    if (double) counters.doubleSubmits++;
    const results = await Promise.all(
      Array.from({ length: double ? 2 : 1 }, () =>
        vu.call('CHECKOUT', 'POST', '/api/checkout', payload),
      ),
    );
    attempt.statuses = results.map((r) => r.status);
    const ok = results.filter((r) => r.status === 200 && r.body?.orderNumber);
    counters.checkoutRejected += results.length - ok.length;
    if (ok.length === 2) counters.doubleSubmitBothOk++;
    if (ok.length) {
      counters.ordersCreated++;
      orders.set(vu.id, {
        orderNumber: ok[0].body.orderNumber,
        orderNumbers: ok.map((r) => r.body.orderNumber),
        items: cart.itemCount,
        total: cart.totalGross,
        seats: [...mine],
        ga,
        email: payload.email,
      });
      if (rand() < 0.2) {
        let page = await vu.call('ORDER_PAGE', 'GET', ok[0].body.redirect);
        // the default locale is served without prefix: follow that single redirect
        if (page.status === 307 || page.status === 308) {
          page = await vu.call('ORDER_PAGE', 'GET', ok[0].body.redirect.replace(/^\/en\//, '/'));
        }
        if (page.status === 200) counters.orderPagesRead++;
      }
    }
  });
  ctx.log(`checkout rush finished in ${Math.round(durationMs)} ms`);

  // ── invariants ──
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const dbOrders = await q(
    `SELECT o.id, o.order_number, o.email, o.total_gross, o.status, o.payment_reference,
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS items
       FROM orders o WHERE o.email LIKE $1`,
    [`load-${runId}-%@example.invalid`],
  );
  // orders the server committed although no client saw a success (lost response / error after commit)
  const clientEmails = new Set([...orders.values()].map((o) => o.email));
  const ghosts = dbOrders.filter((o) => !clientEmails.has(o.email));
  const attemptByEmail = new Map([...attempts.values()].map((a) => [a.email, a]));
  const ghostWithServerError = ghosts.filter((o) =>
    attemptByEmail.get(o.email)?.statuses.some((st) => st >= 500),
  );
  const ghostTimeout = ghosts.filter(
    (o) =>
      !ghostWithServerError.includes(o) &&
      attemptByEmail.get(o.email)?.statuses.some((st) => st === 0),
  );
  const ghostAfterRejection = ghosts.length - ghostWithServerError.length - ghostTimeout.length;
  report.check(
    'no order was committed for a checkout the server answered with 5xx (lost order)',
    ghostWithServerError.length === 0,
    `${ghostWithServerError.length} orders exist for requests answered 5xx; ${ghostTimeout.length} more were committed after the client had given up (timeout, informational)`,
  );
  report.check(
    'a rejected checkout (4xx) never created an order',
    ghostAfterRejection === 0,
    `${ghostAfterRejection} orders`,
  );
  const perEmail = new Map();
  for (const o of dbOrders) perEmail.set(o.email, (perEmail.get(o.email) ?? 0) + 1);
  report.check(
    'one order per customer (double submit created no duplicate)',
    [...perEmail.values()].every((n) => n === 1),
    `${[...perEmail.values()].filter((n) => n > 1).length} customers with several orders; ${counters.doubleSubmitBothOk} double submits answered OK twice`,
  );
  report.check(
    'orders were created (checkout is not vacuously passing)',
    counters.ordersCreated > 0 || counters.withItems === 0,
    `${counters.ordersCreated} orders for ${counters.withItems} users with items; checkout answers ${JSON.stringify(rush.summary(durationMs).endpoints.CHECKOUT?.codes ?? {})}`,
  );
  const byNumber = new Map(dbOrders.map((o) => [o.order_number, o]));
  let wrongItems = 0;
  let wrongTotal = 0;
  let missing = 0;
  for (const o of orders.values()) {
    const row = byNumber.get(o.orderNumber);
    if (!row) missing++;
    else {
      if (row.items !== o.items) wrongItems++;
      if (row.total_gross !== o.total) wrongTotal++;
    }
  }
  report.check(
    'every client order exists with the item count and total the cart showed',
    missing === 0 && wrongItems === 0 && wrongTotal === 0,
    `missing ${missing}, wrong item count ${wrongItems}, wrong total ${wrongTotal}`,
  );
  report.check(
    'every new order has a payment reference',
    dbOrders.every((o) => o.payment_reference),
    `${dbOrders.filter((o) => !o.payment_reference).length} without`,
  );

  // seats of ordered VUs == active items in DB; the rest of the ledger is still locked in Redis
  const orderedSeats = new Set([
    ...[...orders.values()].flatMap((o) => o.seats),
    ...ghosts.flatMap((o) => attemptByEmail.get(o.email)?.seats ?? []),
  ]);
  const dbSeats = new Set(
    (
      await q(
        `SELECT seat_id FROM order_items WHERE event_id = $1 AND seat_id IS NOT NULL
            AND status IN ('PENDING','CONFIRMED') AND order_id = ANY($2)`,
        [eventId, dbOrders.map((o) => o.id)],
      )
    ).map((r) => r.seat_id),
  );
  const diff =
    [...orderedSeats].filter((s) => !dbSeats.has(s)).length +
    [...dbSeats].filter((s) => !orderedSeats.has(s)).length;
  report.check(
    'seats of all orders (client-confirmed + committed-but-unanswered) == seats of the active order items in PostgreSQL',
    diff === 0,
    `${orderedSeats.size} client seats, ${dbSeats.size} db seats, ${diff} differing`,
  );
  const st = await readRedisState(ctx.redis, cfg.prefix, eventId);
  const notReserved = [...orderedSeats].filter((s) => !['R', 'S'].includes(st.taken[s]));
  report.check(
    'ordered seats are marked reserved/sold in Redis',
    notReserved.length === 0,
    `${notReserved.length} not marked`,
  );
  const lockedOrdered = [...orderedSeats].filter((s) => st.locks.has(s));
  report.check(
    'ordered seats no longer carry a cart lock',
    lockedOrdered.length === 0,
    `${lockedOrdered.length} still locked`,
  );
  const leftover = new Map([...ledger.map].filter(([s]) => !orderedSeats.has(s)));
  await checkSeatLocks({
    report,
    redis: ctx.redis,
    cfg,
    eventId,
    ledger: leftover,
    sidOf: (i) => vus[i].sid,
    gaGranted: null,
  });
  const gaOrdered =
    [...orders.values()].reduce((a, o) => a + o.ga, 0) +
    ghosts.reduce((a, o) => a + (attemptByEmail.get(o.email)?.ga ?? 0), 0);
  if (world.ga) {
    const [{ allocated }] = await q(
      `SELECT COALESCE(sum(allocated_count),0)::int AS allocated FROM seat_map_sections WHERE id = $1`,
      [world.ga.id],
    );
    report.check(
      'standing area: allocated_count == spots ordered (client-confirmed + committed-but-unanswered)',
      allocated === gaOrdered,
      `allocated ${allocated}, ordered ${gaOrdered}`,
    );
  }
  await checkDatabase({ report, db, eventId });

  await Promise.all(vus.map((vu) => vu.call('CART_CLEAR', 'DELETE', '/api/cart')));
  return {
    warmup: warm.summary(1),
    rush: rush.summary(durationMs),
    details: {
      ...counters,
      dbOrders: dbOrders.length,
      committedButUnanswered: ghosts.length,
      ghostsWithServerError: ghostWithServerError.length,
      orderedSeats: orderedSeats.size,
      gaOrdered,
    },
  };
}
