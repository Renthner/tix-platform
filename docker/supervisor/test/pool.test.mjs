// Upstream pool selection (docker/supervisor/pool.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpstreamPool, summarizeWebHealth } from '../pool.mjs';

const clock = () => {
  const c = { t: 1_000 };
  c.now = () => c.t;
  return c;
};

test('sequential traffic rotates over all children', () => {
  const pool = new UpstreamPool([1, 2, 3]);
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(pool.pick());
  assert.deepEqual(seen, [0, 1, 2, 0, 1, 2]);
});

test('least requests in flight wins, ties rotate', () => {
  const pool = new UpstreamPool([1, 2, 3]);
  pool.begin(0);
  pool.begin(0);
  pool.begin(1);
  assert.equal(pool.pick(), 2);
  pool.end(0);
  pool.end(0);
  assert.equal(pool.pick(), 0);
  // end() never goes negative
  pool.end(0);
  pool.end(0);
  assert.equal(pool.children[0].inflight, 0);
});

test('a refused child is skipped for a backoff that grows, then retried', () => {
  const c = clock();
  const pool = new UpstreamPool([1, 2], { now: c.now, backoffMs: 1_000, maxBackoffMs: 3_000 });
  pool.markDown(0);
  assert.equal(pool.isDown(0), true);
  assert.equal(pool.allDown(), false);
  for (let i = 0; i < 4; i++) assert.equal(pool.pick(), 1);
  c.t += 1_001;
  assert.equal(pool.isDown(0), false);
  pool.markDown(0); // second failure: 2 s
  c.t += 1_500;
  assert.equal(pool.isDown(0), true);
  c.t += 600;
  assert.equal(pool.isDown(0), false);
  pool.markDown(0);
  pool.markDown(0);
  c.t += 3_001; // capped at 3 s
  assert.equal(pool.isDown(0), false);
  pool.markUp(0);
  assert.equal(pool.children[0].failures, 0);
});

test('every child down: the one that failed longest ago is still tried', () => {
  const c = clock();
  const pool = new UpstreamPool([1, 2, 3], { now: c.now });
  pool.markDown(1);
  c.t += 10;
  pool.markDown(0);
  c.t += 10;
  pool.markDown(2);
  assert.equal(pool.allDown(), true);
  assert.equal(pool.pick(), 1);
});

test('exclude: used for retries, returns null when nothing is left', () => {
  const pool = new UpstreamPool([1, 2, 3]);
  assert.equal(pool.pick(new Set([0, 1])), 2);
  assert.equal(pool.pick(new Set([0, 1, 2])), null);
  pool.markDown(2);
  // 2 is down but the only one not excluded: still offered
  assert.equal(pool.pick(new Set([0, 1])), 2);
});

test('a single child behaves like the old single upstream', () => {
  const pool = new UpstreamPool([3000]);
  assert.equal(pool.pick(), 0);
  assert.equal(pool.pick(), 0);
  pool.markDown(0);
  assert.equal(pool.allDown(), true);
  assert.equal(pool.pick(), 0);
  assert.throws(() => new UpstreamPool([]));
});

test('health aggregation: healthy with at least one ready web process', () => {
  assert.deepEqual(summarizeWebHealth([200]), { ready: 1, total: 1, component: 'ok' });
  assert.deepEqual(summarizeWebHealth([200, 0, 503]), { ready: 1, total: 3, component: 'ok' });
  assert.deepEqual(summarizeWebHealth([0, 0, 503]), { ready: 0, total: 3, component: 'down' });
  assert.deepEqual(summarizeWebHealth([]), { ready: 0, total: 0, component: 'down' });
});

test('a child that is not ready is skipped until setReady(true); all not ready -> still picked', () => {
  const pool = new UpstreamPool([1, 2, 3]);
  pool.setReady(1, false);
  const seen = new Set();
  for (let i = 0; i < 9; i++) seen.add(pool.pick());
  assert.deepEqual([...seen].sort(), [0, 2]);
  assert.equal(pool.allDown(), false);
  pool.setReady(1, true);
  const again = new Set();
  for (let i = 0; i < 9; i++) again.add(pool.pick());
  assert.deepEqual([...again].sort(), [0, 1, 2]);
  for (let i = 0; i < 3; i++) pool.setReady(i, false);
  assert.equal(pool.allDown(), true);
  assert.notEqual(pool.pick(), null);
  assert.equal(pool.pick(new Set([0, 1, 2])), null);
});

test('setReady(true) clears a down mark', () => {
  const c = clock();
  const pool = new UpstreamPool([1, 2], { now: c.now });
  pool.markDown(0);
  assert.equal(pool.isDown(0), true);
  pool.setReady(0, true);
  assert.equal(pool.isDown(0), false);
});
