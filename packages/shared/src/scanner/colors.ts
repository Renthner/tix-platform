import { SCAN_WARNING_PRIORITY, type ScanResult, type ScanWarning } from '../enums';
import type { ScanResultColors } from '../schemas/settings';

/** Colour key (in `scanner.resultColors`) of each warning. */
export const SCAN_WARNING_COLOR_KEY = {
  DISCOUNT_PROOF_REQUIRED: 'discountProof',
  WRONG_ENTRANCE: 'wrongEntrance',
  ADDITIONAL_PAYMENT_OPEN: 'additionalPaymentOpen',
  SEAT_FEATURE: 'seatFeature',
} as const satisfies Record<ScanWarning, keyof ScanResultColors>;

/** The warning that decides the screen colour (first by priority), if any. */
export function leadingWarning(warnings: readonly ScanWarning[]): ScanWarning | null {
  return SCAN_WARNING_PRIORITY.find((w) => warnings.includes(w)) ?? null;
}

/** Screen colour of a scan: rejected, accepted, or the leading warning's colour. */
export function scanResultColor(
  result: ScanResult,
  warnings: readonly ScanWarning[],
  colors: ScanResultColors,
): string {
  if (result.startsWith('REJECTED_')) return colors.rejected;
  const lead = leadingWarning(warnings);
  if (lead) return colors[SCAN_WARNING_COLOR_KEY[lead]];
  return colors.accepted;
}

/** Black or white, whichever reads better on the given `#RRGGBB[AA]` background (WCAG luminance). */
export function readableTextColor(hex: string): '#000000' | '#FFFFFF' {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.179 ? '#000000' : '#FFFFFF';
}
