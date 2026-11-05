// Smoke test against running servers (pnpm dev or docker compose).
// Usage: node scripts/smoke/shop.mjs <eventId> [baseUrl=http://localhost:3000] [realtimeUrl=http://localhost:3001]
// Expects the demo event from `pnpm db:demo` (slug demo-concert) with the waiting room OFF.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');

const [eventId, base = 'http://localhost:3000', rtUrl = 'http://localhost:3001'] =
  process.argv.slice(2);
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` – ${extra}` : ''}`);
};

function session() {
  const jar = new Map();
  const call = async (path, { method = 'GET', json } = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body };
  };
  return { call, jar };
}

const a = session();
const b = session();

const page = await a.call('/events/demo-concert');
check('event page renders', page.status === 200, `status ${page.status}`);
check('proxy issues session cookie', a.jar.has('tix_sid'));
const de = await a.call('/de/events/demo-concert');
check('German locale page renders', de.status === 200 && String(de.body).includes('lang="de"'));

const map = (await a.call(`/api/events/${eventId}/seatmap`)).body;
check(
  'public seat map',
  Array.isArray(map.seats) && map.seats.length > 300,
  `${map.seats?.length} seats`,
);
const rowA = map.rows.find((r) => r.label === 'A');
const rowASeats = map.seats.filter((s) => s.r === rowA.id).sort((x, y) => x.p - y.p);

const enterA = await a.call(`/api/events/${eventId}/enter`, { method: 'POST' });
check('session A enters shop (queue OFF)', enterA.body.status === 'GRANTED');
const enterB = await b.call(`/api/events/${eventId}/enter`, { method: 'POST' });
check('session B enters shop', enterB.body.status === 'GRANTED');

// Observer socket for session B
const token = (await b.call('/api/session/realtime-token')).body.token;
const deltas = [];
const socket = io(rtUrl, { path: '/socket.io', transports: ['websocket'], auth: { token } });
await new Promise((resolve, reject) => {
  socket.on('connect', resolve);
  socket.on('connect_error', reject);
});
socket.emit('seats:subscribe', eventId);
socket.on('seats:delta', (d) => deltas.push(d));
await new Promise((r) => setTimeout(r, 200));

const target = rowASeats[1];
const lockA = await a.call(`/api/events/${eventId}/seats`, {
  method: 'POST',
  json: { seatIds: [target.i] },
});
check('A locks seat A2', lockA.status === 200, `status ${lockA.status}`);
const lockB = await b.call(`/api/events/${eventId}/seats`, {
  method: 'POST',
  json: { seatIds: [target.i] },
});
check(
  'B is rejected for the same seat',
  lockB.status === 409 && lockB.body.error.code === 'SEAT_LOCKED',
  JSON.stringify(lockB.body.error),
);

await new Promise((r) => setTimeout(r, 600));
check(
  'B receives realtime delta (batched)',
  deltas.some((d) => d.seats.some(([id, s]) => id === target.i && s === 'L')),
  `${deltas.length} frame(s)`,
);

const availB = (await b.call(`/api/events/${eventId}/availability`)).body;
check('availability shows seat as locked for B', availB.locked.includes(target.i));

const orphan = (await a.call(`/api/events/${eventId}/selection`, { method: 'POST' })).body;
check(
  'orphan rule flags A1 (single seat left)',
  orphan.ok === false && orphan.orphanSeatIds.includes(rowASeats[0].i),
);
await a.call(`/api/events/${eventId}/seats`, {
  method: 'POST',
  json: { seatIds: [rowASeats[0].i] },
});
const fixed = (await a.call(`/api/events/${eventId}/selection`, { method: 'POST' })).body;
check('selection valid after adding A1', fixed.ok === true);

const cart1 = (await a.call('/api/cart')).body;
check('cart contains 2 seats', cart1.itemCount === 2, `total ${cart1.totalGross}`);
const reduced = cart1.events[0].ticketTypes.find(
  (t) => t.requiresProofAtEntry && !t.requiredSeatFeature,
);
const tariff = await a.call('/api/cart/tariff', {
  method: 'PATCH',
  json: { eventId, itemKey: target.i, ticketTypeId: reduced.id },
});
const cart2 = (await a.call('/api/cart')).body;
check(
  'tariff per seat changes total',
  tariff.status === 200 && cart2.totalGross < cart1.totalGross,
  `${cart1.totalGross} → ${cart2.totalGross}`,
);

const cat = map.categories[1];
const best = await b.call(`/api/events/${eventId}/best-available`, {
  method: 'POST',
  json: { categoryId: cat.id, quantity: 3 },
});
check(
  'best available locks 3 adjacent seats',
  best.status === 200 && best.body.seatIds?.length === 3,
  JSON.stringify(best.body).slice(0, 120),
);

const ga = map.sections.find((s) => s.type === 'STANDING');
const gaRes = await b.call(`/api/events/${eventId}/general-admission`, {
  method: 'PUT',
  json: { sectionId: ga.id, quantity: 2 },
});
check(
  'standing spots held',
  gaRes.status === 200 && gaRes.body.held === 2,
  JSON.stringify(gaRes.body),
);
const cartB = (await b.call('/api/cart')).body;
check('B cart: 3 seats + 2 standing', cartB.itemCount === 5);
const removeGa = await b.call('/api/cart/items', {
  method: 'DELETE',
  json: { eventId, itemKey: `ga:${ga.id}:0` },
});
check(
  'remove one standing spot',
  removeGa.status === 200 && (await b.call('/api/cart')).body.itemCount === 4,
);

const limit = await a.call(`/api/events/${eventId}/seats`, {
  method: 'POST',
  json: { seatIds: rowASeats.slice(4, 14).map((s) => s.i) },
});
check(
  'ticket limit enforced (max 10 per order)',
  limit.status === 422 && limit.body.error.code === 'TICKET_LIMIT',
);

const noPass = session();
await noPass.call('/events/demo-concert');
const denied = await noPass.call(`/api/events/${eventId}/seats`, {
  method: 'POST',
  json: { seatIds: [rowASeats[6].i] },
});
check(
  'locking without queue pass is refused',
  denied.status === 403 && denied.body.error.code === 'PASS_REQUIRED',
);

const cleared = await a.call('/api/cart', { method: 'DELETE' });
await b.call('/api/cart', { method: 'DELETE' });
const after = (await noPass.call(`/api/events/${eventId}/availability`)).body;
check(
  'clearing carts releases all locks',
  cleared.status === 204 && after.locked.length === 0,
  `${after.locked.length} locked`,
);

socket.close();
const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
