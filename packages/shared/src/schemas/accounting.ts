import { z } from 'zod';

/**
 * Accounting export settings (DATEV Buchungsstapel + simple CSV).
 *
 * The account numbers below are *starting values* for a tax advisor to confirm – the shop never
 * decides the chart of accounts. Every account is editable in Admin → Accounting.
 */

export const ACCOUNTING_CHARTS = ['SKR03', 'SKR04', 'CUSTOM'] as const;
export type AccountingChart = (typeof ACCOUNTING_CHARTS)[number];

/** Ledger account digits (DATEV accounts have at most 9 digits). */
const accountSchema = z.string().regex(/^[0-9]{1,9}$/, 'invalid');

/** DATEV "BU-Schlüssel": up to four digits, empty = none (automatic account). */
const buKeySchema = z
  .string()
  .regex(/^[0-9]{1,4}$/, 'invalid')
  .optional();

export const taxAccountSchema = z.object({
  /** VAT rate in basis points (1900 = 19 %, 0 = tax exempt / small business). */
  rateBasisPoints: z.number().int().min(0).max(10_000),
  revenueAccount: accountSchema,
  /** Service fees (order fees) of that rate; empty = same account as tickets. */
  feeAccount: accountSchema.optional(),
  /** Explicit tax key. Leave empty for automatic revenue accounts – a key on top books VAT twice. */
  buKey: buKeySchema,
});
export type TaxAccount = z.infer<typeof taxAccountSchema>;

export interface AccountingAccountPreset {
  taxAccounts: TaxAccount[];
  debtorAccount: string;
  bankAccount: string;
  paypalAccount: string;
  cashAccount: string;
  cardAccount: string;
  /** Account for written-off shortfalls (debit side). */
  writeOffAccount: string;
}

/**
 * Common standard accounts per chart – DEFAULTS ONLY, to be confirmed by the tax advisor.
 * SKR03: 8300 / 8400 revenue 7 % / 19 % (automatic), 8100 tax-exempt (§ 4 Nr. 8 ff. UStG),
 * 1200 bank, 1360 money in transit, 1000 cash. SKR04: 4300 / 4400, 4100, 1800, 1460, 1600.
 * Write-off account (shortfall written off): 8730 / 4730 "Gewährte Skonti" – alternatively a bad-debt
 * account (Forderungsverluste); how a write-off is treated for VAT is for the tax advisor to decide.
 * 10000 is the first personal account (debtor) of both charts, used as collective debtor.
 */
const PRESETS: Record<'SKR03' | 'SKR04', AccountingAccountPreset> = {
  SKR03: {
    taxAccounts: [
      { rateBasisPoints: 0, revenueAccount: '8100' },
      { rateBasisPoints: 700, revenueAccount: '8300' },
      { rateBasisPoints: 1900, revenueAccount: '8400' },
    ],
    debtorAccount: '10000',
    bankAccount: '1200',
    paypalAccount: '1360',
    cashAccount: '1000',
    cardAccount: '1360',
    writeOffAccount: '8730',
  },
  SKR04: {
    taxAccounts: [
      { rateBasisPoints: 0, revenueAccount: '4100' },
      { rateBasisPoints: 700, revenueAccount: '4300' },
      { rateBasisPoints: 1900, revenueAccount: '4400' },
    ],
    debtorAccount: '10000',
    bankAccount: '1800',
    paypalAccount: '1460',
    cashAccount: '1600',
    cardAccount: '1460',
    writeOffAccount: '4730',
  },
};

/** Shorter numbers are extended with trailing zeros to the account length (DATEV convention). */
export function padAccount(account: string, length: number): string {
  return account.length < length ? account.padEnd(length, '0') : account;
}

/** Preset accounts for a chart, extended to `accountLength` (debtors: one digit more). CUSTOM starts from SKR03. */
export function accountingPreset(chart: AccountingChart, accountLength: number) {
  const base = PRESETS[chart === 'SKR04' ? 'SKR04' : 'SKR03'];
  const pad = (a: string | undefined) => (a ? padAccount(a, accountLength) : a);
  return {
    taxAccounts: base.taxAccounts.map((r) => ({
      ...r,
      revenueAccount: pad(r.revenueAccount)!,
      feeAccount: pad(r.feeAccount),
    })),
    debtorAccount: padAccount(base.debtorAccount, accountLength + 1),
    bankAccount: padAccount(base.bankAccount, accountLength),
    paypalAccount: padAccount(base.paypalAccount, accountLength),
    cashAccount: padAccount(base.cashAccount, accountLength),
    cardAccount: padAccount(base.cardAccount, accountLength),
    writeOffAccount: padAccount(base.writeOffAccount, accountLength),
  } satisfies AccountingAccountPreset;
}

export const accountingSchema = z
  .object({
    chart: z.enum(ACCOUNTING_CHARTS).default('SKR03'),
    /** Beraternummer (DATEV consultant number, 1001–9999999). Needed for the DATEV file only. */
    consultantNumber: z.number().int().min(1001).max(9_999_999).optional(),
    /** Mandantennummer (client number, 1–99999). Needed for the DATEV file only. */
    clientNumber: z.number().int().min(1).max(99_999).optional(),
    /** First day of the fiscal year, MM-DD. */
    fiscalYearStart: z
      .string()
      .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, 'invalid')
      .refine((v) => {
        const [m, d] = v.split('-').map(Number) as [number, number];
        return d <= new Date(Date.UTC(2001, m, 0)).getUTCDate();
      }, 'invalid')
      .default('01-01'),
    /** Sachkontenlänge: digits of ledger accounts (debtors have one more). */
    accountLength: z.number().int().min(4).max(8).default(4),
    taxAccounts: z.array(taxAccountSchema).max(30).default(PRESETS.SKR03.taxAccounts),
    debtorAccount: accountSchema.default(PRESETS.SKR03.debtorAccount),
    bankAccount: accountSchema.default(PRESETS.SKR03.bankAccount),
    paypalAccount: accountSchema.default(PRESETS.SKR03.paypalAccount),
    cashAccount: accountSchema.default(PRESETS.SKR03.cashAccount),
    cardAccount: accountSchema.default(PRESETS.SKR03.cardAccount),
    /** Shortfalls written off when settling an order; empty = chart default (to be confirmed). */
    writeOffAccount: accountSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', path, message: 'accountLength' });
    v.taxAccounts.forEach((r, i) => {
      if (r.revenueAccount.length !== v.accountLength) issue(['taxAccounts', i, 'revenueAccount']);
      if (r.feeAccount && r.feeAccount.length !== v.accountLength)
        issue(['taxAccounts', i, 'feeAccount']);
      if (v.taxAccounts.findIndex((o) => o.rateBasisPoints === r.rateBasisPoints) !== i)
        ctx.addIssue({
          code: 'custom',
          path: ['taxAccounts', i, 'rateBasisPoints'],
          message: 'duplicate',
        });
    });
    if (v.debtorAccount.length !== v.accountLength + 1) issue(['debtorAccount']);
    for (const key of ['bankAccount', 'paypalAccount', 'cashAccount', 'cardAccount'] as const) {
      if (v[key].length !== v.accountLength) issue([key]);
    }
    if (v.writeOffAccount && v.writeOffAccount.length !== v.accountLength)
      issue(['writeOffAccount']);
  })
  .transform((v) => ({
    ...v,
    writeOffAccount:
      v.writeOffAccount ?? accountingPreset(v.chart, v.accountLength).writeOffAccount,
  }));
export type AccountingSettings = z.output<typeof accountingSchema>;
