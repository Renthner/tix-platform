'use server';

import {
  DomainError,
  createEventFee,
  createGlobalFee,
  createTaxRate,
  deleteEventFee,
  deleteGlobalFee,
  deleteTaxRate,
  reorderGlobalFees,
  resetEventFee,
  setEventFeeOverride,
  setGlobalFeeActive,
  updateEventFee,
  updateGlobalFee,
  updateTaxRate,
  waiveEventFee,
} from '@tix/core';
import { withTransaction, type Transaction } from '@tix/db';
import { eventFeeFormSchema, globalFeeFormSchema, taxRateFormSchema } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin, type AdminSession } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

/**
 * Fees & tax rates (admin). Global fees and tax rates: FINANCE (SUPER_ADMIN always passes);
 * per-event fees: EVENT_MANAGER. All mutations go through the core services and are audited
 * in the same transaction.
 */

/** Domain errors with their own explanation in the `fees` messages. */
export type FeeErrorCode =
  | 'TAX_RATE_IN_USE'
  | 'FEE_HAS_OVERRIDES'
  | 'FEE_NOT_OVERRIDABLE'
  | 'FEE_SCOPE_NOT_ALLOWED'
  | 'FEE_ORDER_INVALID';
export type FeeMessageCode = 'waived' | 'reset' | 'reordered';

export type FeeActionState = ActionState & { feeError?: FeeErrorCode; feeMessage?: FeeMessageCode };

const GLOBAL_ROLES = ['FINANCE'] as const;
const EVENT_ROLES = ['EVENT_MANAGER'] as const;

const feeError = (code: FeeErrorCode): FeeActionState => ({
  status: 'error',
  feeError: code,
  at: Date.now(),
});

const feeSuccess = (feeMessage: FeeMessageCode): FeeActionState => ({
  status: 'success',
  feeMessage,
  at: Date.now(),
});

const FEE_ERRORS: readonly string[] = [
  'TAX_RATE_IN_USE',
  'FEE_HAS_OVERRIDES',
  'FEE_NOT_OVERRIDABLE',
  'FEE_SCOPE_NOT_ALLOWED',
  'FEE_ORDER_INVALID',
] satisfies FeeErrorCode[];

/** Maps domain errors of the core services to form states; anything else is rethrown. */
function mapError(err: unknown, context: 'taxRate' | 'fee'): FeeActionState {
  if (!(err instanceof DomainError)) throw err;
  if (FEE_ERRORS.includes(err.code)) return feeError(err.code as FeeErrorCode);
  switch (err.code) {
    case 'TAX_RATE_NAME_TAKEN':
      return fieldError({ name: 'nameTaken' });
    case 'TAX_RATE_NOT_FOUND':
      // for fees: the chosen tax rate was deleted in the meantime
      return context === 'fee' ? fieldError({ taxRateId: 'invalid' }) : formError('notFound');
    case 'FEE_NOT_FOUND':
    case 'EVENT_NOT_FOUND':
      return formError('notFound');
    default:
      return formError('generic');
  }
}

/** Runs a core mutation and its audit entry in one transaction. */
async function mutate<T>(
  session: AdminSession,
  fn: (tx: Transaction) => Promise<T>,
  log: (
    result: T,
  ) => [
    action: string,
    entityType: string,
    entityId: string | null,
    changes?: Record<string, unknown>,
  ],
): Promise<T> {
  return withTransaction(getCore().db, async (tx) => {
    const result = await fn(tx);
    const [action, entityType, entityId, changes] = log(result);
    await audit(tx, session, action, entityType, entityId, changes);
    return result;
  });
}

function refresh(): void {
  revalidatePath('/', 'layout');
}

function feeFormValues(fd: FormData) {
  return {
    name: text(fd, 'name'),
    scope: text(fd, 'scope'),
    calculation: text(fd, 'calculation'),
    value: text(fd, 'value'),
    taxRateId: text(fd, 'taxRateId') ?? '',
    paymentMethods: fd.getAll('paymentMethods').map(String),
    channels: fd.getAll('channels').map(String),
    isActive: flag(fd, 'isActive'),
    sortOrder: text(fd, 'sortOrder'),
  };
}

const uuid = z.uuid();

// ─── Tax rates ──────────────────────────────────────────────────────────────

export async function saveTaxRateAction(
  taxRateId: string | null,
  _prev: FeeActionState,
  fd: FormData,
): Promise<FeeActionState> {
  const session = await requireAdmin(GLOBAL_ROLES);
  const parsed = taxRateFormSchema.safeParse({
    name: text(fd, 'name'),
    rate: text(fd, 'rate'),
    invoiceNote: text(fd, 'invoiceNote'),
    isDefault: flag(fd, 'isDefault'),
    isActive: flag(fd, 'isActive'),
    sortOrder: text(fd, 'sortOrder'),
  });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const input = parsed.data;
  try {
    if (taxRateId) {
      await mutate(
        session,
        (tx) => updateTaxRate(tx, taxRateId, input),
        ({ before }) => ['taxrate.update', 'tax_rate', taxRateId, { before, after: input }],
      );
    } else {
      await mutate(
        session,
        (tx) => createTaxRate(tx, input),
        (row) => ['taxrate.create', 'tax_rate', row.id, input],
      );
    }
  } catch (err) {
    return mapError(err, 'taxRate');
  }
  refresh();
  return success(taxRateId ? 'saved' : 'created');
}

export async function deleteTaxRateAction(
  taxRateId: string,
  _prev: FeeActionState,
): Promise<FeeActionState> {
  const session = await requireAdmin(GLOBAL_ROLES);
  try {
    await mutate(
      session,
      (tx) => deleteTaxRate(tx, taxRateId),
      (row) => [
        'taxrate.delete',
        'tax_rate',
        taxRateId,
        { name: row.name, rateBasisPoints: row.rateBasisPoints },
      ],
    );
  } catch (err) {
    return mapError(err, 'taxRate');
  }
  refresh();
  return success('deleted');
}

// ─── Global fees ────────────────────────────────────────────────────────────

export async function saveGlobalFeeAction(
  feeId: string | null,
  _prev: FeeActionState,
  fd: FormData,
): Promise<FeeActionState> {
  const session = await requireAdmin(GLOBAL_ROLES);
  const parsed = globalFeeFormSchema.safeParse(feeFormValues(fd));
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const input = parsed.data;
  try {
    if (feeId) {
      await mutate(
        session,
        (tx) => updateGlobalFee(tx, feeId, input),
        ({ before }) => ['fee.update', 'fee', feeId, { before, after: input }],
      );
    } else {
      await mutate(
        session,
        (tx) => createGlobalFee(tx, input),
        (row) => ['fee.create', 'fee', row.id, input],
      );
    }
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return success(feeId ? 'saved' : 'created');
}

export async function setGlobalFeeActiveAction(
  feeId: string,
  isActive: boolean,
): Promise<FeeActionState> {
  const session = await requireAdmin(GLOBAL_ROLES);
  if (!uuid.safeParse(feeId).success || typeof isActive !== 'boolean') return formError('generic');
  try {
    await mutate(
      session,
      (tx) => setGlobalFeeActive(tx, feeId, isActive),
      (row) => ['fee.update', 'fee', feeId, { name: row.name, isActive }],
    );
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return success('saved');
}

export async function reorderGlobalFeesAction(orderedIds: string[]): Promise<FeeActionState> {
  const session = await requireAdmin(GLOBAL_ROLES);
  try {
    await mutate(
      session,
      (tx) => reorderGlobalFees(tx, orderedIds),
      () => ['fee.reorder', 'fee', null, { order: orderedIds }],
    );
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return feeSuccess('reordered');
}

export async function deleteGlobalFeeAction(
  feeId: string,
  _prev: FeeActionState,
): Promise<FeeActionState> {
  const session = await requireAdmin(GLOBAL_ROLES);
  try {
    await mutate(
      session,
      (tx) => deleteGlobalFee(tx, feeId),
      ({ fee, removedOverrides }) => [
        'fee.delete',
        'fee',
        feeId,
        { name: fee.name, removedOverrides },
      ],
    );
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return success('deleted');
}

// ─── Per event ──────────────────────────────────────────────────────────────

export async function saveEventFeeOverrideAction(
  eventId: string,
  globalFeeId: string,
  _prev: FeeActionState,
  fd: FormData,
): Promise<FeeActionState> {
  const session = await requireAdmin(EVENT_ROLES);
  const parsed = eventFeeFormSchema.safeParse({ ...feeFormValues(fd), isActive: true });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const input = parsed.data;
  try {
    await mutate(
      session,
      (tx) => setEventFeeOverride(tx, eventId, globalFeeId, input),
      ({ before, after }) => [
        'fee.override',
        'fee',
        after.id,
        { eventId, globalFeeId, before, after: input },
      ],
    );
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return success('saved');
}

export async function waiveEventFeeAction(
  eventId: string,
  globalFeeId: string,
  _prev: FeeActionState,
): Promise<FeeActionState> {
  const session = await requireAdmin(EVENT_ROLES);
  try {
    await mutate(
      session,
      (tx) => waiveEventFee(tx, eventId, globalFeeId),
      (row) => ['fee.waive', 'fee', row.id, { eventId, globalFeeId, name: row.name }],
    );
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return feeSuccess('waived');
}

export async function resetEventFeeAction(
  eventId: string,
  globalFeeId: string,
  _prev: FeeActionState,
): Promise<FeeActionState> {
  const session = await requireAdmin(EVENT_ROLES);
  try {
    await mutate(
      session,
      (tx) => resetEventFee(tx, eventId, globalFeeId),
      (removed) => ['fee.reset', 'fee', removed?.id ?? null, { eventId, globalFeeId, removed }],
    );
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return feeSuccess('reset');
}

export async function saveEventFeeAction(
  eventId: string,
  feeId: string | null,
  _prev: FeeActionState,
  fd: FormData,
): Promise<FeeActionState> {
  const session = await requireAdmin(EVENT_ROLES);
  const parsed = eventFeeFormSchema.safeParse(feeFormValues(fd));
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const input = parsed.data;
  try {
    if (feeId) {
      await mutate(
        session,
        (tx) => updateEventFee(tx, eventId, feeId, input),
        ({ before }) => ['fee.update', 'fee', feeId, { eventId, before, after: input }],
      );
    } else {
      await mutate(
        session,
        (tx) => createEventFee(tx, eventId, input),
        (row) => ['fee.create', 'fee', row.id, { eventId, ...input }],
      );
    }
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return success(feeId ? 'saved' : 'created');
}

export async function deleteEventFeeAction(
  eventId: string,
  feeId: string,
  _prev: FeeActionState,
): Promise<FeeActionState> {
  const session = await requireAdmin(EVENT_ROLES);
  try {
    await mutate(
      session,
      (tx) => deleteEventFee(tx, eventId, feeId),
      (row) => ['fee.delete', 'fee', feeId, { eventId, name: row.name }],
    );
  } catch (err) {
    return mapError(err, 'fee');
  }
  refresh();
  return success('deleted');
}
