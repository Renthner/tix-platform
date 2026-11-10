'use server';

import { saveSetting } from '@tix/core';
import { accountingSchema } from '@tix/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, success, text, zodFieldErrors } from './form';

/** Form field names of the tax account rows: `taxRate_0`, `taxRevenue_0`, `taxFee_0`, `taxBu_0`. */
const ROW_FIELDS = {
  rateBasisPoints: 'taxRate',
  revenueAccount: 'taxRevenue',
  feeAccount: 'taxFee',
  buKey: 'taxBu',
} as const;

/** "19", "7,5" → basis points; undefined when not a number. */
function percentToBasisPoints(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

function optionalInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : Number.NaN;
}

/** Saves the accounting settings (FINANCE may edit them; SUPER_ADMIN passes every role check). */
export async function saveAccountingSettingsAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['FINANCE']);
  const rowCount = Math.min(Math.max(Number(fd.get('taxRowCount')) || 0, 0), 30);
  const taxAccounts = Array.from({ length: rowCount }, (_, i) => ({
    rateBasisPoints: percentToBasisPoints(text(fd, `${ROW_FIELDS.rateBasisPoints}_${i}`)),
    revenueAccount: text(fd, `${ROW_FIELDS.revenueAccount}_${i}`),
    feeAccount: text(fd, `${ROW_FIELDS.feeAccount}_${i}`),
    buKey: text(fd, `${ROW_FIELDS.buKey}_${i}`),
  }));
  const input = {
    chart: text(fd, 'chart'),
    consultantNumber: optionalInt(text(fd, 'consultantNumber')),
    clientNumber: optionalInt(text(fd, 'clientNumber')),
    fiscalYearStart: text(fd, 'fiscalYearStart'),
    accountLength: optionalInt(text(fd, 'accountLength')),
    taxAccounts,
    debtorAccount: text(fd, 'debtorAccount'),
    bankAccount: text(fd, 'bankAccount'),
    paypalAccount: text(fd, 'paypalAccount'),
    cashAccount: text(fd, 'cashAccount'),
    cardAccount: text(fd, 'cardAccount'),
    writeOffAccount: text(fd, 'writeOffAccount') || undefined,
  };
  const parsed = accountingSchema.safeParse(input);
  if (!parsed.success) return fieldError(mapErrors(parsed.error));

  const core = getCore();
  const saved = await saveSetting(core, 'accounting', parsed.data, session.userId);
  await audit(core.db, session, 'settings.update', 'system_setting', 'accounting', {
    value: saved,
  });
  revalidatePath('/', 'layout');
  return success('saved');
}

/** Zod paths `taxAccounts.2.revenueAccount` → form field `taxRevenue_2`. */
function mapErrors(error: z.ZodError) {
  const base = zodFieldErrors(error);
  const out: ReturnType<typeof zodFieldErrors> = {};
  for (const [path, code] of Object.entries(base)) {
    const match = /^taxAccounts\.(\d+)\.(\w+)$/.exec(path);
    const field = match ? ROW_FIELDS[match[2] as keyof typeof ROW_FIELDS] : undefined;
    out[match && field ? `${field}_${match[1]}` : path] =
      code === 'required' && match ? 'invalid' : code;
  }
  return out;
}
