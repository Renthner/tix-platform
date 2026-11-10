# Accounting export (tax advisor / treasurer)

Admin → **Accounting** (`/admin/accounting`, role FINANCE; SUPER_ADMIN passes every role check).
It exports the bookkeeping data of a date range as

- a **DATEV booking batch** (Buchungsstapel, EXTF 700, data category 21), and
- three **simple CSV files**: invoices & credit notes, payments, refunds.

> **All account numbers are defaults only.** The SKR03 / SKR04 numbers below are common
> standard accounts, offered as starting values. The shop cannot know how your organisation is
> treated for tax purposes (tax-exempt non-profit areas, small-business rule, economic
> operations, …). **Have the chart, the accounts, the tax keys and the file format confirmed by
> your tax advisor before the first real import** (a test import into DATEV is recommended).

## What is exported

| Data         | Selected by                                                | Source tables                         |
| ------------ | ---------------------------------------------------------- | ------------------------------------- |
| Invoices     | issue date (`invoices.issued_at`)                          | `invoices`, `invoice_lines`           |
| Credit notes | issue date; amounts are stored (and exported) **negative** | `invoices` (`type = CREDIT_NOTE`)     |
| Payments     | capture date (`payments.captured_at`)                      | `payments` (captured, later refunded) |
| Refunds      | processing date (`refunds.processed_at`), status SUCCEEDED | `refunds`                             |

- Range boundaries are **local dates in the shop time zone** (Settings → General), inclusive:
  from `00:00` of the first day up to (excluding) `00:00` of the day after the last day.
  An invoice issued at 23:30 UTC on 31 December therefore belongs to 1 January in Germany.
- Reversed bank allocations (payment `CANCELLED`): the original payment **stays in the period of its
  capture** (so earlier, already imported files remain correct), and a **reversing booking dated at
  the reversal** (`bank_transaction_allocations.reversed_at`) corrects it in the period of the
  reversal. In the payments CSV it is a negative row with the note `PAYMENT_REVERSED`.
- Shortfalls written off (`order_history` entry `shortfall_written_off`, bank underpayment within
  the matching tolerance): booked at the payment date; booked back at the reversal date when the
  allocation is reversed later. In the payments CSV they carry the note `SHORTFALL_WRITE_OFF` /
  `SHORTFALL_WRITE_OFF_REVERSED` (not money received - leave them out when summing receipts).
- Not exported: other `CANCELLED` payments (never captured), complimentary
  (`COMPLIMENTARY`) payments and zero amounts, refunds that are still pending or failed.
- Refunds of captures that belong to no order item (late payments after a cancellation) are
  exported too – the money really left the account.
- A payment is booked against the order's **current invoice number** (the latest invoice that no
  credit note cancelled completely), so open items match in DATEV; without an invoice the order
  number is used.
- Every export writes an audit entry (`accounting.export`: kind, range, row count – no personal
  data). Exports are built in memory; they are meant for months or years of a club-sized shop.

## Simple CSV

UTF-8 **with BOM**, separator `;`, **decimal comma** (no thousands separator), CRLF – opens
directly in Excel with a German locale. Text cells that start with `= + - @` are prefixed with `'`
so a spreadsheet never evaluates buyer-supplied text; amounts are never altered. Dates are
`YYYY-MM-DD` in the shop time zone. Headers follow the admin language; enumerations (`INVOICE`,
`CREDIT_NOTE`, `BANK_TRANSFER`, …) are language neutral.

- **Documents**: one row per document and tax rate (from the invoice's tax breakdown): number,
  type, date, corrected invoice, order, buyer name/company, net, tax rate %, tax, gross, currency,
  payment method, order status.
- **Payments**: date, order, invoice, method, amount, currency, payment reference
  (Verwendungszweck), provider capture id / bank end-to-end id.
- **Refunds**: date, order, method, amount, currency, credit note, kind (AUTOMATIC / MANUAL),
  status.

## DATEV booking batch

Format: **EXTF, version 700, data category 21 "Buchungsstapel", format version 13**. File name
`EXTF_Buchungsstapel_<from>_<to>.csv`. Line 1 is the header record (31 fields), line 2 the **125
official column captions** (format version 13; unquoted), then one record per booking padded to
all 125 columns. Text fields in `"` (doubled inside), numbers unquoted, `;` separator, CRLF,
**Windows-1252** (characters outside it become `?`), amounts with decimal comma and without
thousands separator. `Festschreibung` is 0 (not locked), currency EUR (other currencies stop the
export), one fiscal year per file (a range crossing the fiscal-year end is rejected).

Header fields (1-based): 1 `"EXTF"`, 2 `700`, 3 `21`, 4 `"Buchungsstapel"`, 5 format version
(`13`), 6 created (`yyyyMMddHHmmssSSS`, shop time zone), 7 imported (empty), 8 origin (2 chars),
9 exported by (≤ 25), 10 imported by (empty), **11 consultant number**, **12 client number**,
**13 fiscal-year start** (`yyyyMMdd`), **14 account length**, **15/16 date from / to**, 17
description (≤ 30), 18 dictation code (empty), 19 booking type `1` (financial accounting), 20
accounting purpose `0`, 21 lock flag `0`, 22 `"EUR"`, 27 chart (`"03"` / `"04"`), 31 application
info (empty). Format version 12 (116 columns) is the minimum DATEV still accepts; 13 adds nine
columns at the end (`Fälligkeit` … `Abw. Skontokonto`).

Filled booking columns: 1 Umsatz (positive, comma), 2 Soll/Haben, 3 WKZ, **7 Konto**, **8
Gegenkonto**, 9 BU-Schlüssel, 10 Belegdatum (`DDMM`, shop time zone), **11 Belegfeld 1** (≤ 36
characters from `A-Z a-z 0-9 $ & % * + - /`, everything else becomes `-`), 14 Buchungstext (≤ 60).
All other columns stay empty. No customer names are exported to DATEV.

Sources (the DATEV developer portal is JavaScript-rendered and could not be read automatically;
the column list and header layout were cross-checked against the open-source Ruby gem
ledermann/datev, which implements the DATEV documents 1036228 / developer.datev.de "DATEV-Format"
and ships an example file of format version 13 with 125 columns):

- DATEV developer portal, DATEV-Format (header, Buchungsstapel): https://developer.datev.de/datev/platform/en/dtvf
  and https://developer.datev.de/datev/platform/en/dtvf/formate/header (minimum: main version 700,
  Buchungsstapel format version 12; current samples use 13).
- DATEV Hilfe-Center, Dok.-Nr. 1036228 "DATEV-Format - Beschreibung Buchungsstapel".
- https://github.com/ledermann/datev (`lib/datev/base/header.rb`, `booking.rb`,
  `examples/EXTF_Buchungsstapel.csv`): field order, limits, column captions, CRLF, Windows-1252.

### Postings

One **collective debtor** account (default `10000`) carries all customers.

| Document         | Konto (S/H)                       | Gegenkonto                      | Belegfeld 1                    |
| ---------------- | --------------------------------- | ------------------------------- | ------------------------------ |
| Invoice          | debtor **S**                      | revenue account of the tax rate | invoice number                 |
| Credit note      | debtor **H** (reversal)           | revenue account of the tax rate | credit note number             |
| Payment          | money account of the method **S** | debtor                          | current invoice / order number |
| Refund           | money account of the method **H** | debtor                          | credit note / order number     |
| Payment reversal | money account of the method **H** | debtor                          | current invoice / order number |
| Write-off        | debtor **H**                      | write-off account               | current invoice / order number |

- Invoices are booked **gross** per tax rate (tickets and fees of the same rate and account are
  merged; a separate _fee account_ per rate is optional). Zero-amount bookings are skipped (DATEV
  rejects `0,00`). A document whose lines do not add up to its total stops the export.
- Default (**automatic revenue accounts**): no BU key – DATEV derives the tax from the account.
  An explicit BU key per rate can be set; do **not** set one on an automatic account (the tax
  would be booked twice).
- A tax rate that occurs on a document but has no row in the settings stops the export and
  lists the missing rates (no silent fallback). Use a **0 %** row for tax-exempt sales and for
  small-business / non-profit exemption.
- A bank allocation reversed after the payment was exported is corrected by a reversing booking
  at the reversal date (money account **H** / debtor **S**, text "Payment reversed"); earlier files
  are never changed.
- A bank underpayment settled as "shortfall written off" is booked at the payment date: debtor **H** /
  write-off account **S** (setting "Written-off shortfalls"; default SKR03 8730 / SKR04 4730
  "Gewährte Skonti", alternatively a bad-debt account - **to be confirmed by the tax advisor**, as is
  any VAT correction). A reversed allocation books it back (debtor S / write-off account H).
- There is no separate "refunds payable" account: a credit note (debtor H) and the refund payout (debtor S) both use the collective debtor, which carries the credit balance until the money has left.
- Accounts are validated to have exactly the configured account length (debtors: one more
  digit); presets are extended with trailing zeros for longer account lengths.

### Default accounts (to be confirmed by the tax advisor)

| Purpose                   | SKR03 | SKR04 |
| ------------------------- | ----- | ----- |
| Revenue 19 % (automatic)  | 8400  | 4400  |
| Revenue 7 % (automatic)   | 8300  | 4300  |
| Tax-exempt revenue (0 %)  | 8100  | 4100  |
| Bank (bank transfer)      | 1200  | 1800  |
| PayPal (money in transit) | 1360  | 1460  |
| Cash                      | 1000  | 1600  |
| Card (money in transit)   | 1360  | 1460  |
| Collective debtor         | 10000 | 10000 |
| Written-off shortfalls    | 8730  | 4730  |

## Settings

Stored as system setting `accounting` (Zod schema `accountingSchema` in
`packages/shared/src/schemas/accounting.ts`): chart (SKR03 / SKR04 / custom), consultant and client
number, fiscal-year start (`MM-DD`), account length, accounts per tax rate (revenue, optional fee
account, optional BU key), collective debtor, money accounts per payment method, write-off account. The page offers a
button that fills in the defaults of the selected chart. Changes are audited as `settings.update`.

## Tests

`packages/core/test/accounting.test.ts` (unit: header field positions, booking rows against a
hand-checked fixture, escaping, Windows-1252, CSV, presets, fiscal-year logic) and
`packages/core/test/accounting.integration.test.ts` (throw-away database: range selection in the
shop time zone, credit notes negative, cancelled / pending money excluded).
