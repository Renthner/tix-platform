// Invariant checks against Redis and PostgreSQL. These are the pass/fail criteria of the load
// test: a violation means a double booking / lost update and makes the run exit non-zero.
import { UUID_RE, keyspace, scanKeys } from './common.mjs';

export class Report {
  constructor(name) {
    this.name = name;
    this.checks = [];
  }
  check(title, ok, detail = '') {
    this.checks.push({ title, ok: Boolean(ok), detail: String(detail) });
    return Boolean(ok);
  }
  skip(title, reason) {
    this.checks.push({ title, ok: true, skipped: true, detail: reason });
  }
  get failed() {
    return this.checks.filter((c) => !c.ok);
  }
}

/** Reads all seat locks + cart sets of the event from Redis. */
export async function readRedisState(redis, prefix, eventId) {
  const k = keyspace(prefix, eventId);
  const lockKeys = (await scanKeys(redis, k.seatLockPattern)).filter((key) =>
    UUID_RE.test(key.slice(key.lastIndexOf(':') + 1)),
  );
  const locks = new Map(); // seatId -> owner session
  if (lockKeys.length) {
    const owners = await redis.mget(lockKeys);
    lockKeys.forEach((key, i) => locks.set(key.slice(key.lastIndexOf(':') + 1), owners[i]));
  }
  const cartKeys = await scanKeys(redis, k.cartSeatsPattern);
  const carts = new Map(); // session -> Set(seatId)
  for (const key of cartKeys) {
    const sid = key.slice(`${k.ev}:cart:`.length, -':seats'.length);
    carts.set(sid, new Set(await redis.smembers(key)));
  }
  const taken = await redis.hgetall(k.taken);
  const gaHeld = await redis.hgetall(k.gaHeld);
  const gaAvailable = await redis.hgetall(k.gaAvailable);
  return { locks, carts, taken, gaHeld, gaAvailable };
}

/**
 * Seat-lock invariants. `ledger` maps seatId -> [vuIndex...] of every VU that was told "locked";
 * `sidOf(vuIndex)` gives that VU's session id; `gaGranted` is the total number of standing spots
 * granted (or null to skip). `released` seats are excluded from the exact-equality check.
 */
export async function checkSeatLocks({ report, redis, cfg, eventId, ledger, sidOf, gaGranted }) {
  const st = await readRedisState(redis, cfg.prefix, eventId);
  const multi = [...ledger].filter(([, vus]) => vus.length > 1);
  report.check(
    'no seat was granted to two virtual users (client ledger)',
    multi.length === 0,
    `${multi.length} seats granted twice` + (multi[0] ? ` e.g. ${multi[0][0]}` : ''),
  );
  const missing = [...ledger.keys()].filter((id) => !st.locks.has(id));
  const extra = [...st.locks.keys()].filter((id) => !ledger.has(id));
  report.check(
    'Redis lock set == seats the clients were granted',
    missing.length === 0 && extra.length === 0,
    `${ledger.size} granted, ${st.locks.size} locked in Redis, ${missing.length} missing, ${extra.length} unknown`,
  );
  let wrongOwner = 0;
  for (const [seat, vus] of ledger) {
    if (vus.length === 1 && st.locks.get(seat) && st.locks.get(seat) !== sidOf(vus[0]))
      wrongOwner++;
  }
  report.check(
    'every lock is owned by the session the winning request came from',
    wrongOwner === 0,
    `${wrongOwner} locks with a different owner`,
  );
  // cart sets: lock owner's set contains the seat; sets are pairwise disjoint
  const seen = new Map();
  let dup = 0;
  for (const [sid, set] of st.carts) {
    for (const seat of set) {
      if (seen.has(seat) && seen.get(seat) !== sid) dup++;
      seen.set(seat, sid);
    }
  }
  report.check('cart seat sets of different sessions are disjoint', dup === 0, `${dup} overlaps`);
  let notInCart = 0;
  for (const [seat, owner] of st.locks) if (!st.carts.get(owner)?.has(seat)) notInCart++;
  let cartWithoutLock = 0;
  for (const [sid, set] of st.carts)
    for (const seat of set) if (st.locks.get(seat) !== sid) cartWithoutLock++;
  report.check(
    'lock keys and per-session cart sets agree (both directions)',
    notInCart === 0 && cartWithoutLock === 0,
    `${notInCart} locks missing in cart set, ${cartWithoutLock} cart entries without lock`,
  );
  const lockedAndTaken = [...st.locks.keys()].filter((id) => st.taken[id] !== undefined);
  report.check(
    'no seat is locked and sold/reserved/blocked at the same time',
    lockedAndTaken.length === 0,
    `${lockedAndTaken.length} seats`,
  );
  const held = Object.values(st.gaHeld).reduce((a, b) => a + Number(b), 0);
  const avail = Object.values(st.gaAvailable).reduce((a, b) => a + Number(b), 0);
  report.check(
    'standing area: held spots never exceed the available capacity',
    Object.keys(st.gaHeld).every((id) => Number(st.gaHeld[id]) <= Number(st.gaAvailable[id] ?? 0)),
    `held ${held} / available ${avail}`,
  );
  if (gaGranted !== null && gaGranted !== undefined) {
    report.check(
      'standing area: Redis held == spots granted to clients',
      held === gaGranted,
      `held ${held}, granted ${gaGranted}`,
    );
  }
  return st;
}

/** Database invariants valid at any time (also after the checkout rush). */
export async function checkDatabase({ report, db, eventId }) {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;

  const doubleSeat = await q(
    `SELECT seat_id, count(*) FROM order_items
      WHERE seat_id IS NOT NULL AND status IN ('PENDING','CONFIRMED')
      GROUP BY seat_id HAVING count(*) > 1`,
  );
  report.check(
    'no seat in two active order items',
    doubleSeat.length === 0,
    `${doubleSeat.length}`,
  );

  const [{ seats_total }] = await q(
    `SELECT count(*)::int AS seats_total FROM seats s
       JOIN events e ON e.seat_map_id = s.seat_map_id WHERE e.id = $1`,
    [eventId],
  ).catch(() => [{ seats_total: null }]);
  const [{ active_seats }] = await q(
    `SELECT count(DISTINCT seat_id)::int AS active_seats FROM order_items
      WHERE event_id = $1 AND seat_id IS NOT NULL AND status IN ('PENDING','CONFIRMED')`,
    [eventId],
  );
  report.check(
    'sold + reserved seats <= seat capacity of the event',
    seats_total === null || active_seats <= seats_total,
    `${active_seats} of ${seats_total}`,
  );

  const ga = await q(
    `SELECT s.id, s.name, s.capacity, s.allocated_count,
            COALESCE((SELECT count(*) FROM order_items i WHERE i.section_id = s.id
                       AND i.kind = 'GENERAL_ADMISSION' AND i.status IN ('PENDING','CONFIRMED')), 0)::int AS items
       FROM seat_map_sections s
       JOIN events e ON e.seat_map_id = s.seat_map_id
      WHERE e.id = $1 AND s.type = 'STANDING'`,
    [eventId],
  );
  for (const s of ga) {
    report.check(
      `standing "${s.name}": allocated_count (${s.allocated_count}) <= capacity (${s.capacity})`,
      s.allocated_count <= s.capacity,
    );
    report.check(
      `standing "${s.name}": allocated_count == active order items`,
      s.allocated_count === s.items,
      `allocated ${s.allocated_count}, items ${s.items}`,
    );
  }

  const [uniq] = await q(
    `SELECT count(*)::int AS n, count(DISTINCT order_number)::int AS nums,
            count(DISTINCT payment_reference)::int AS refs,
            count(payment_reference)::int AS refs_set
       FROM orders`,
  );
  report.check('order numbers are unique', uniq.nums === uniq.n, `${uniq.nums}/${uniq.n}`);
  report.check(
    'payment references (Verwendungszweck) are unique',
    uniq.refs === uniq.refs_set,
    `${uniq.refs} distinct of ${uniq.refs_set}`,
  );

  const [inv] = await q(
    `SELECT count(*)::int AS n, count(DISTINCT invoice_number)::int AS nums FROM invoices`,
  );
  report.check('invoice numbers are unique', inv.n === inv.nums, `${inv.nums}/${inv.n}`);

  const empty = await q(
    `SELECT o.id FROM orders o WHERE o.status IN ('PENDING','AWAITING_PAYMENT','PAID')
        AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)`,
  );
  report.check('no live order without items', empty.length === 0, `${empty.length}`);

  const badTotals = await q(
    `SELECT o.id FROM orders o
      WHERE o.total_gross <> COALESCE((SELECT sum(price_gross) FROM order_items i WHERE i.order_id = o.id AND i.status <> 'CANCELLED'), 0)
                           + COALESCE((SELECT sum(total_gross) FROM order_fees f WHERE f.order_id = o.id), 0)
        AND o.status IN ('PENDING','AWAITING_PAYMENT','PAID')`,
  );
  report.check(
    'order totals == items + fees',
    badTotals.length === 0,
    `${badTotals.length} orders`,
  );
}
