import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DASHBOARD_STATUSES,
  applyVisibleOrder,
  dashboardPreferencesInputSchema,
  parseDashboardPreferences,
  sortByEventOrder,
} from '../src';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

describe('dashboard preferences', () => {
  it('validates the save input strictly', () => {
    const ok = (v: unknown) => dashboardPreferencesInputSchema.safeParse(v).success;
    expect(ok({})).toBe(true);
    expect(ok({ eventOrder: [A, B], statusFilter: ['DRAFT', 'ARCHIVED'] })).toBe(true);
    expect(ok({ eventOrder: ['not-a-uuid'] })).toBe(false);
    expect(ok({ eventOrder: [A, A] })).toBe(false);
    expect(ok({ statusFilter: [] })).toBe(false);
    expect(ok({ statusFilter: ['PUBLISHED', 'PUBLISHED'] })).toBe(false);
    expect(ok({ statusFilter: ['SOLD_OUT'] })).toBe(false);
    expect(ok({ other: 1 })).toBe(false);
    expect(ok({ eventOrder: Array.from({ length: 501 }, () => crypto.randomUUID()) })).toBe(false);
  });

  it('reads stored data leniently', () => {
    expect(parseDashboardPreferences(null)).toEqual({
      eventOrder: [],
      statusFilter: DEFAULT_DASHBOARD_STATUSES,
    });
    expect(parseDashboardPreferences({ eventOrder: [A], statusFilter: ['nope'] })).toEqual({
      eventOrder: [A],
      statusFilter: DEFAULT_DASHBOARD_STATUSES,
    });
  });

  it('sorts by the saved order, new and unknown ids handled', () => {
    const items = [{ id: A }, { id: B }, { id: C }];
    expect(sortByEventOrder(items, [C, D, A]).map((i) => i.id)).toEqual([C, A, B]);
    expect(sortByEventOrder(items, []).map((i) => i.id)).toEqual([A, B, C]);
  });

  it('keeps the slots of hidden events when visible cards are rearranged', () => {
    expect(applyVisibleOrder([A, B, C], [C, A])).toEqual([C, B, A]);
    expect(applyVisibleOrder([A], [B, A])).toEqual([B, A]);
    expect(applyVisibleOrder([], [B, A])).toEqual([B, A]);
  });
});
