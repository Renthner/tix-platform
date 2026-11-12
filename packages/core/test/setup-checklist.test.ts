import { describe, expect, it } from 'vitest';
import { buildSetupChecklist, type SetupFacts } from '../src/setup-checklist';

const empty: SetupFacts = {
  organizer: {},
  emailSent: false,
  paypalUsable: false,
  bankTransferUsable: false,
  bankAccountMissing: true,
  scannerServerUrl: { explicit: false, reachableFromPhone: false },
  hasSeatPlan: false,
  hasPublishedEvent: false,
  backupScheduleEnabled: false,
  backupExternalEnabled: false,
  twoFactorEnabled: false,
};

const complete: SetupFacts = {
  organizer: {
    legalName: 'Club e.V.',
    street: 'Main St 1',
    postalCode: '12345',
    city: 'Town',
    email: 'info@example.org',
  },
  emailSent: true,
  paypalUsable: false,
  bankTransferUsable: true,
  bankAccountMissing: false,
  scannerServerUrl: { explicit: true, reachableFromPhone: true },
  hasSeatPlan: true,
  hasPublishedEvent: true,
  backupScheduleEnabled: true,
  backupExternalEnabled: true,
  twoFactorEnabled: true,
};

describe('buildSetupChecklist', () => {
  it('fresh install: nothing done, bank link points to the accounts page', () => {
    const c = buildSetupChecklist(empty);
    expect(c.total).toBe(8);
    expect(c.doneCount).toBe(0);
    expect(c.allDone).toBe(false);
    expect(c.steps.find((s) => s.key === 'payment')?.href).toBe('/admin/banking/accounts');
  });

  it('everything done', () => {
    const c = buildSetupChecklist(complete);
    expect(c.doneCount).toBe(8);
    expect(c.allDone).toBe(true);
  });

  it('organizer needs name, address and e-mail', () => {
    const organizer = { ...complete.organizer, city: '  ' };
    const step = buildSetupChecklist({ ...complete, organizer }).steps[0]!;
    expect(step.done).toBe(false);
  });

  it('scanner URL must be reachable from a phone (explicit or APP_URL fallback)', () => {
    const step = (explicit: boolean, reachableFromPhone: boolean) =>
      buildSetupChecklist({
        ...complete,
        scannerServerUrl: { explicit, reachableFromPhone },
      }).steps.find((s) => s.key === 'scanner')!;
    expect(step(true, false).done).toBe(false);
    expect(step(false, false).done).toBe(false);
    expect(step(false, true).done).toBe(true);
    expect(step(true, true).done).toBe(true);
  });

  it('PayPal alone satisfies the payment step', () => {
    const step = buildSetupChecklist({
      ...complete,
      paypalUsable: true,
      bankTransferUsable: false,
      bankAccountMissing: false,
    }).steps.find((s) => s.key === 'payment')!;
    expect(step.done).toBe(true);
    expect(step.href).toBe('/admin/settings/payments');
  });

  it('backups: external target hint only when a schedule runs without one', () => {
    const find = (f: SetupFacts) => buildSetupChecklist(f).steps.find((s) => s.key === 'backups')!;
    expect(find({ ...complete, backupExternalEnabled: false }).hint).toBe('externalBackup');
    expect(find(complete).hint).toBeUndefined();
    expect(find(empty).hint).toBeUndefined();
  });
});
