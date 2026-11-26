// Send-button rule of the event mailing (run via `pnpm --filter @tix/web test`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailingSendBlock } from '../src/lib/mailing-send-status.ts';

const base = { subject: 'Hello', body: 'Text', count: 3, countFailed: false, sending: false };

test('can send with recipients, subject and body', () => {
  assert.equal(mailingSendBlock(base), null);
});

test('blocks a second submission while sending', () => {
  assert.equal(mailingSendBlock({ ...base, sending: true }), 'SENDING');
});

test('blocks while counting and when counting failed', () => {
  assert.equal(mailingSendBlock({ ...base, count: null }), 'COUNTING');
  assert.equal(mailingSendBlock({ ...base, count: null, countFailed: true }), 'COUNT_FAILED');
});

test('blocks without recipients and without subject or body', () => {
  assert.equal(mailingSendBlock({ ...base, count: 0 }), 'NO_RECIPIENTS');
  assert.equal(mailingSendBlock({ ...base, subject: '  ' }), 'EMPTY');
  assert.equal(mailingSendBlock({ ...base, body: '' }), 'EMPTY');
});
