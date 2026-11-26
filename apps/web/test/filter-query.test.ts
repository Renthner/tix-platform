// Query building of the auto-applying admin filter forms (run via `pnpm --filter @tix/web test`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalQuery,
  filterEntriesToParams,
  isApplicableDateValue,
} from '../src/lib/filter-query.ts';

test('builds the query like a GET submit without empty values and the page', () => {
  const params = filterEntriesToParams([
    ['q', 'eva'],
    ['status', ''],
    ['event', 'a'],
    ['event', 'b'],
    ['page', '3'],
    ['pageSize', '25'],
  ]);
  assert.equal(params.toString(), 'q=eva&event=a&event=b&pageSize=25');
});

test('canonical query ignores order, empty values and the page', () => {
  assert.equal(canonicalQuery('?b=2&a=1&page=4&c='), canonicalQuery('a=1&b=2'));
  assert.notEqual(canonicalQuery('a=1'), canonicalQuery('a=2'));
  assert.equal(canonicalQuery('?event=b&event=a'), canonicalQuery('event=a&event=b'));
});

test('date values apply only when complete with a plausible year or empty', () => {
  assert.equal(isApplicableDateValue('date', ''), true);
  assert.equal(isApplicableDateValue('date', '2026-11-26'), true);
  assert.equal(isApplicableDateValue('date', '0002-11-26'), false);
  assert.equal(isApplicableDateValue('date', '0202-11-26'), false);
  assert.equal(isApplicableDateValue('date', '2026-11'), false);
  assert.equal(isApplicableDateValue('month', '2026-11'), true);
  assert.equal(isApplicableDateValue('datetime-local', '2026-11-26T18:30'), true);
});
