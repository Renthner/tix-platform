import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedChild, backoffDelay, formatChildLine, lineSplitter } from '../children.mjs';

test('log lines: pino JSON intact, others prefixed', () => {
  assert.equal(formatChildLine('web', '{"level":30,"msg":"x"}'), '{"level":30,"msg":"x"}');
  assert.equal(formatChildLine('web', 'plain text'), '[web] plain text');
  assert.equal(formatChildLine('web', '{not json'), '[web] {not json');
  assert.equal(formatChildLine('migrate', '[migrate] done'), '[migrate] done');
});

test('line splitter handles partial chunks', () => {
  const lines = [];
  const s = lineSplitter((l) => lines.push(l));
  s.push('a\nb');
  s.push('c\r\n\nd');
  s.flush();
  assert.deepEqual(lines, ['a', 'bc', 'd']);
});

test('backoff doubles up to the cap', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
});

test('a crashing child is restarted with backoff; stop() ends it for good', async () => {
  const logs = [];
  const lines = [];
  const log = { info: () => {}, warn: () => {}, error: (m, e) => logs.push([m, e]) };
  const child = new ManagedChild({
    name: 'x',
    args: ['-e', 'console.log("hi"); process.exit(3)'],
    env: process.env,
    cwd: process.cwd(),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    log,
    baseDelayMs: 20,
  });
  child.start();
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(child.restarts >= 2, `restarts=${child.restarts}`);
  assert.ok(lines.filter((l) => l === '[x] hi').length >= 3);
  assert.equal(logs[0][1].code, 3);
  await child.stop(1000);
  const before = child.restarts;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(child.restarts, before);
  assert.equal(child.running, false);
});

test(
  'stop() sends SIGTERM and escalates to SIGKILL',
  { skip: process.platform === 'win32' },
  async () => {
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const child = new ManagedChild({
      name: 'stubborn',
      args: ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'],
      env: process.env,
      cwd: process.cwd(),
      out: () => {},
      err: () => {},
      log,
    });
    child.start();
    await new Promise((r) => setTimeout(r, 500));
    const t = Date.now();
    await child.stop(400);
    assert.ok(Date.now() - t >= 350 && Date.now() - t < 3000);
    assert.equal(child.running, false);
  },
);
