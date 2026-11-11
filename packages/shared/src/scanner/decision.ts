import type {
  CheckInState,
  ScanAction,
  ScanResult,
  ScanWarning,
  SeatFeature,
  TicketStatus,
} from '../enums';

/**
 * Scan decision table shared by the server (online scans, offline batch merge) and – as a
 * specification, see docs/SCANNER.md – by the Android app. Pure: no I/O, no clock.
 */

/** What the decision needs to know about a ticket. */
export interface DecisionTicket {
  status: TicketStatus;
  checkInState: CheckInState;
  /** The ticket type is a reduction whose proof is checked at the door. */
  requiresProof: boolean;
  seatFeature: SeatFeature | null;
  /** A tariff-change additional payment is still open (never blocks entry). */
  additionalPaymentOpen: boolean;
  /** Entrance of the ticket's block (null = block has no assigned entrance). */
  entranceId: string | null;
}

export interface DecisionInput {
  action: ScanAction;
  /** null = no such ticket. */
  ticket: DecisionTicket | null;
  /** Entrance the scanning device is stationed at (null = any). */
  deviceEntranceId: string | null;
  /** Global `scanner.allowCheckOut` AND the device's `allow_check_out` for the event. */
  checkOutAllowed: boolean;
  /**
   * Stale scan: the scan time is older than the last state-changing scan of the ticket (a late
   * offline upload). A stale scan never changes the check-in state (nextState is always null).
   */
  stale?: boolean;
  /** The scan time is older than the ticket's first recorded check-in. */
  scannedBeforeFirstEntry?: boolean;
  /**
   * The same upload contains a CHECK_OUT of this ticket between this scan and the first recorded
   * entry: both entries were real (guest left and came back).
   */
  exitBetween?: boolean;
}

export interface ScanDecision {
  result: ScanResult;
  warnings: ScanWarning[];
  /** New check-in state; null = unchanged (every REJECTED_* result). */
  nextState: CheckInState | null;
}

export function decideScan(input: DecisionInput): ScanDecision {
  const { ticket } = input;
  if (!ticket) return reject('REJECTED_UNKNOWN_TICKET');
  if (ticket.status !== 'VALID') return reject('REJECTED_TICKET_VOID');

  if (input.action === 'CHECK_OUT') {
    if (!input.checkOutAllowed) return reject('REJECTED_CHECK_OUT_NOT_ALLOWED');
    if (input.stale) {
      // Historic check-out: valid when the guest had entered before it; never changes state.
      return input.scannedBeforeFirstEntry || ticket.checkInState === 'NONE'
        ? reject('REJECTED_NOT_CHECKED_IN')
        : { result: 'ACCEPTED', warnings: [], nextState: null };
    }
    if (ticket.checkInState !== 'CHECKED_IN') return reject('REJECTED_NOT_CHECKED_IN');
    return { result: 'ACCEPTED', warnings: [], nextState: 'CHECKED_OUT' };
  }

  if (input.stale) {
    // Historic check-in. Exactly one check-in per stay is accepted: a stale one is a duplicate
    // entry (possible copied ticket) unless the upload proves a check-out between it and the
    // recorded first entry. Never changes state (a duplicate that is older than the first entry
    // only moves first_checked_in_*, see the server).
    if (!input.scannedBeforeFirstEntry || !input.exitBetween) {
      return reject('REJECTED_ALREADY_CHECKED_IN');
    }
  } else if (ticket.checkInState === 'CHECKED_IN') {
    return reject('REJECTED_ALREADY_CHECKED_IN');
  }

  const warnings: ScanWarning[] = [];
  if (ticket.requiresProof) warnings.push('DISCOUNT_PROOF_REQUIRED');
  if (
    input.deviceEntranceId !== null &&
    ticket.entranceId !== null &&
    input.deviceEntranceId !== ticket.entranceId
  ) {
    warnings.push('WRONG_ENTRANCE');
  }
  if (ticket.seatFeature) warnings.push('SEAT_FEATURE');
  if (ticket.additionalPaymentOpen) warnings.push('ADDITIONAL_PAYMENT_OPEN');
  return {
    result: warnings.length > 0 ? 'ACCEPTED_WITH_WARNING' : 'ACCEPTED',
    warnings,
    nextState: input.stale ? null : 'CHECKED_IN',
  };
}

function reject(result: ScanResult): ScanDecision {
  return { result, warnings: [], nextState: null };
}

export type ScanColor = 'GREEN' | 'YELLOW' | 'RED';

export function scanColor(result: ScanResult): ScanColor {
  if (result === 'ACCEPTED') return 'GREEN';
  if (result === 'ACCEPTED_WITH_WARNING') return 'YELLOW';
  return 'RED';
}

/** Results that changed the ticket's check-in state. */
export function isAcceptedResult(result: ScanResult): boolean {
  return result === 'ACCEPTED' || result === 'ACCEPTED_WITH_WARNING';
}
