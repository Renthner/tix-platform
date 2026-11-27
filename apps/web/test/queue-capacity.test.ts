// Server-wide waiting-room cap: only super-admins change it, only when the field was posted
// (run via `pnpm --filter @tix/web test`, Node type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEditServerCapacity, shouldSaveServerCapacity } from '../src/lib/queue-capacity.ts';

test('only super-admins see the server-wide cap', () => {
  assert.equal(canEditServerCapacity(['SUPER_ADMIN']), true);
  assert.equal(canEditServerCapacity(['EVENT_MANAGER', 'SUPER_ADMIN']), true);
  assert.equal(canEditServerCapacity(['EVENT_MANAGER']), false);
  assert.equal(canEditServerCapacity([]), false);
});

test('the cap is saved only from the global form, with the field, by a super-admin', () => {
  const base = { eventId: null, hasField: true, roles: ['SUPER_ADMIN'] };
  assert.equal(shouldSaveServerCapacity(base), true);
  assert.equal(shouldSaveServerCapacity({ ...base, hasField: false }), false, 'field absent');
  assert.equal(shouldSaveServerCapacity({ ...base, eventId: 'e1' }), false, 'event form');
  assert.equal(
    shouldSaveServerCapacity({ ...base, roles: ['EVENT_MANAGER'] }),
    false,
    'event manager post with the field is ignored',
  );
});
