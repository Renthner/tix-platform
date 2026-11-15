import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, versionCode } from './version.mjs';

test('stage ranges keep every pre-release version code below the final one and apart', () => {
  assert.equal(versionCode('1.0.0-alpha.1'), 1_000_001);
  assert.equal(versionCode('1.0.0-alpha.29'), 1_000_029);
  assert.equal(versionCode('1.0.0-alpha.30'), 1_000_030);
  assert.equal(versionCode('1.0.0-alpha.49'), 1_000_049);
  assert.equal(versionCode('1.0.0-beta.1'), 1_000_051);
  assert.equal(versionCode('1.0.0-beta.19'), 1_000_069);
  assert.equal(versionCode('1.0.0-rc.1'), 1_000_071);
  assert.equal(versionCode('1.0.0-rc.19'), 1_000_089);
  assert.equal(versionCode('1.0.0'), 1_000_099);
});

test('version codes increase with the version order', () => {
  const order = [
    '1.0.0-alpha.1',
    '1.0.0-alpha.49',
    '1.0.0-beta.1',
    '1.0.0-beta.19',
    '1.0.0-rc.1',
    '1.0.0-rc.19',
    '1.0.0',
    '1.0.1-alpha.1',
  ];
  const codes = order.map(versionCode);
  assert.deepEqual(
    [...codes].sort((a, b) => a - b),
    codes,
  );
  assert.equal(new Set(codes).size, codes.length);
});

test('out of range pre-release numbers are rejected', () => {
  for (const bad of [
    '1.0.0-alpha.0',
    '1.0.0-alpha.50',
    '1.0.0-beta.20',
    '1.0.0-rc.20',
    '1.0.0-rc.0',
  ]) {
    assert.throws(() => parseVersion(bad), /must be between/, bad);
  }
});
