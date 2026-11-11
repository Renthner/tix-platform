// node --test scripts/release
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movingTags } from './channel-tags.mjs';
import { compareVersions } from './version.mjs';

const tags = (v, all) => movingTags(v, all);

test('SemVer precedence incl. pre-release ordering', () => {
  const order = [
    '1.0.0-alpha.1',
    '1.0.0-alpha.2',
    '1.0.0-beta.1',
    '1.0.0-rc.1',
    '1.0.0-rc.2',
    '1.0.0',
    '1.0.1',
    '1.1.0-alpha.1',
    '1.1.0',
    '2.0.0-alpha.1',
  ];
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(compareVersions(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
    assert.ok(compareVersions(order[i + 1], order[i]) > 0);
  }
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('first alpha', () => {
  assert.deepEqual(tags('1.0.0-alpha.1', ['1.0.0-alpha.1']), ['next', 'alpha']);
});

test('newer alpha moves next and alpha', () => {
  assert.deepEqual(tags('1.0.0-alpha.2', ['1.0.0-alpha.1', '1.0.0-alpha.2']), ['next', 'alpha']);
});

test('older alpha rebuild does not move anything', () => {
  assert.deepEqual(tags('1.0.0-alpha.1', ['1.0.0-alpha.1', '1.0.0-alpha.2']), []);
});

test('beta after alpha moves next and beta, not alpha of a newer line', () => {
  assert.deepEqual(tags('1.0.0-beta.1', ['1.0.0-alpha.3', '1.0.0-beta.1']), ['next', 'beta']);
  assert.deepEqual(tags('1.0.0-alpha.4', ['1.0.0-alpha.4', '1.1.0-alpha.1']), []);
});

test('stable release moves everything', () => {
  assert.deepEqual(tags('1.0.0', ['1.0.0-rc.1', '1.0.0']), [
    'next',
    'latest',
    'stable',
    '1',
    '1.0',
  ]);
});

test('pre-release never moves latest, stable, X or X.Y', () => {
  assert.deepEqual(tags('1.1.0-rc.1', ['1.0.0', '1.1.0-rc.1']), ['next', 'rc']);
});

test('patch of an older line after a newer pre-release does not move next', () => {
  assert.deepEqual(tags('1.0.1', ['1.0.0', '1.0.1', '1.1.0-alpha.1']), [
    'latest',
    'stable',
    '1',
    '1.0',
  ]);
});

test('patch of an older line after a newer stable only moves X.Y', () => {
  assert.deepEqual(tags('1.0.1', ['1.0.0', '1.0.1', '1.1.0']), ['1.0']);
});

test('new major moves latest but leaves the old major tag alone', () => {
  assert.deepEqual(tags('2.0.0', ['1.4.2', '2.0.0']), ['next', 'latest', 'stable', '2', '2.0']);
  assert.deepEqual(tags('1.4.3', ['1.4.2', '1.4.3', '2.0.0']), ['1', '1.4']);
});

test('invalid tags are ignored, the version itself need not be listed', () => {
  assert.deepEqual(tags('1.0.0', ['junk', '1.0.0-alpha.1']), [
    'next',
    'latest',
    'stable',
    '1',
    '1.0',
  ]);
});

test('invalid version throws', () => {
  assert.throws(() => tags('1.0', []));
});
