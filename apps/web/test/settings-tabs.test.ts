// Role map of the admin settings pages (run via `pnpm --filter @tix/web test`, Node type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedSettingsTabs,
  parseOpenSettingsGroups,
  SETTINGS_ROLES,
  SETTINGS_TABS,
  settingsGroupsFor,
} from '../src/lib/settings-tabs.ts';

test('super admin sees every settings page in every group', () => {
  assert.deepEqual(allowedSettingsTabs(['SUPER_ADMIN']), [...SETTINGS_TABS]);
  const groups = settingsGroupsFor(['SUPER_ADMIN']);
  assert.equal(groups.length, 7);
  assert.deepEqual(
    groups.flatMap((g) => g.tabs),
    [...SETTINGS_TABS],
  );
});

test('finance sees only the fees page', () => {
  assert.deepEqual(allowedSettingsTabs(['FINANCE']), ['fees']);
  assert.deepEqual(settingsGroupsFor(['FINANCE']), [{ group: 'sales', tabs: ['fees'] }]);
});

test('event manager sees fees and the waiting room', () => {
  assert.deepEqual(allowedSettingsTabs(['EVENT_MANAGER']), ['fees', 'waitingRoom']);
  assert.deepEqual(settingsGroupsFor(['EVENT_MANAGER']), [
    { group: 'sales', tabs: ['fees', 'waitingRoom'] },
  ]);
});

test('door staff sees no settings page', () => {
  assert.deepEqual(allowedSettingsTabs(['DOOR_STAFF']), []);
  assert.deepEqual(settingsGroupsFor(['DOOR_STAFF']), []);
  assert.ok(!SETTINGS_ROLES.includes('DOOR_STAFF'));
});

test('the overview is open to every role with at least one page', () => {
  assert.deepEqual([...SETTINGS_ROLES].sort(), ['EVENT_MANAGER', 'FINANCE', 'SUPER_ADMIN']);
});

test('open menu groups from the cookie keep known keys only', () => {
  assert.deepEqual(parseOpenSettingsGroups(undefined), []);
  assert.deepEqual(parseOpenSettingsGroups(''), []);
  assert.deepEqual(parseOpenSettingsGroups('system, sales,junk,,system,__proto__'), [
    'system',
    'sales',
  ]);
  assert.deepEqual(parseOpenSettingsGroups('design%2Ctickets'), ['design', 'tickets']);
  assert.deepEqual(parseOpenSettingsGroups('%E0%A4%A,shop'), ['shop']);
});
