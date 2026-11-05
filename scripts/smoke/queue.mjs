// Smoke test against running servers (pnpm dev or docker compose).
// Usage: node scripts/smoke/queue.mjs <eventId> [baseUrl] [realtimeUrl]
// Requires the event's waiting room in mode HYBRID (batch size 1) and a running worker.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');
const [eventId, base = 'http://localhost:3000', rtUrl = 'http://localhost:3001'] =
  process.argv.slice(2);

function session() {
  const jar = new Map();
  return async (path, method = 'GET') => {
    const res = await fetch(base + path, {
      method,
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res.json().catch(() => null);
  };
}

const visitors = [session(), session()];
const started = Date.now();
const decisions = [];
for (const v of visitors) decisions.push(await v(`/api/events/${eventId}/enter`, 'POST'));
console.log(
  'initial:',
  decisions
    .map(
      (d) =>
        `${d.status}${d.number ? ` #${d.number} pos ${d.position} eta ${d.estimatedWaitSeconds}s` : ''}`,
    )
    .join(' | '),
);

const admittedAt = await Promise.all(
  visitors.map(
    (v, i) =>
      new Promise(async (resolve) => {
        const { token } = await v('/api/session/realtime-token');
        const socket = io(rtUrl, {
          path: '/socket.io',
          transports: ['websocket'],
          auth: { token },
        });
        socket.on('connect', () => socket.emit('queue:subscribe', eventId));
        socket.on(
          'queue:update',
          (m) =>
            m.type === 'cursor' &&
            console.log(`  visitor ${i + 1} sees cursor ${m.cursor}, waiting ${m.waiting}`),
        );
        socket.on('session:message', async (m) => {
          if (m.type !== 'admitted') return;
          const claim = await v(`/api/events/${eventId}/claim`, 'POST');
          console.log(
            `  visitor ${i + 1} admitted after ${((Date.now() - started) / 1000).toFixed(1)}s → claim ${claim.status}`,
          );
          socket.close();
          resolve(claim.status === 'GRANTED' ? Date.now() : null);
        });
        setTimeout(() => {
          socket.close();
          resolve(null);
        }, 20_000);
      }),
  ),
);
const ok = admittedAt.every(Boolean) && admittedAt[0] <= admittedAt[1];
console.log(
  ok ? 'QUEUE E2E PASSED (FIFO order, worker admission, pass claimed)' : 'QUEUE E2E FAILED',
);
process.exit(ok ? 0 : 1);
