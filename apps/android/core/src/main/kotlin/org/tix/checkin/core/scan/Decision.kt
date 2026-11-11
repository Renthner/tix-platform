package org.tix.checkin.core.scan

import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.contract.TicketStatus

/**
 * Port of `decideScan` (packages/shared/src/scanner/decision.ts) - the decision table of
 * docs/SCANNER.md. Pure: no I/O, no clock. Keep it identical to the server's version.
 */
data class DecisionTicket(
    val status: TicketStatus,
    val checkInState: CheckInState,
    /** The ticket type is a reduction whose proof is checked at the door. */
    val requiresProof: Boolean,
    val seatFeature: SeatFeature?,
    /** A tariff-change additional payment is still open (never blocks entry). */
    val additionalPaymentOpen: Boolean,
    /** Entrance of the ticket's block (null = block has no assigned entrance). */
    val entranceId: String?,
)

data class DecisionInput(
    val action: ScanAction,
    /** null = no such ticket. */
    val ticket: DecisionTicket?,
    /** Entrance the scanning device is stationed at (null = any). */
    val deviceEntranceId: String?,
    /** Global allow-check-out AND the device's permission for the event. */
    val checkOutAllowed: Boolean,
    /**
     * Stale scan: the scan time is older than the last state-changing scan of the ticket (a late
     * offline upload). A stale scan never changes the check-in state (nextState is always null).
     */
    val stale: Boolean = false,
    /** The scan time is older than the ticket's first recorded check-in. */
    val scannedBeforeFirstEntry: Boolean = false,
    /**
     * The same upload contains a CHECK_OUT of this ticket between this scan and the first recorded
     * entry: both entries were real (guest left and came back).
     */
    val exitBetween: Boolean = false,
)

data class ScanDecision(
    val result: ScanResult,
    val warnings: List<ScanWarning>,
    /** New check-in state; null = unchanged (every REJECTED_* result). */
    val nextState: CheckInState?,
)

fun decideScan(input: DecisionInput): ScanDecision {
    val ticket = input.ticket ?: return reject(ScanResult.REJECTED_UNKNOWN_TICKET)
    if (ticket.status != TicketStatus.VALID) return reject(ScanResult.REJECTED_TICKET_VOID)

    if (input.action == ScanAction.CHECK_OUT) {
        if (!input.checkOutAllowed) return reject(ScanResult.REJECTED_CHECK_OUT_NOT_ALLOWED)
        if (input.stale) {
            // Historic check-out: valid when the guest had entered before it; never changes state.
            return if (input.scannedBeforeFirstEntry || ticket.checkInState == CheckInState.NONE) {
                reject(ScanResult.REJECTED_NOT_CHECKED_IN)
            } else {
                ScanDecision(ScanResult.ACCEPTED, emptyList(), null)
            }
        }
        if (ticket.checkInState != CheckInState.CHECKED_IN) return reject(ScanResult.REJECTED_NOT_CHECKED_IN)
        return ScanDecision(ScanResult.ACCEPTED, emptyList(), CheckInState.CHECKED_OUT)
    }

    if (input.stale) {
        // Exactly one check-in per stay: a stale one is a duplicate entry unless the upload proves a
        // check-out between it and the recorded first entry.
        if (!input.scannedBeforeFirstEntry || !input.exitBetween) return reject(ScanResult.REJECTED_ALREADY_CHECKED_IN)
    } else if (ticket.checkInState == CheckInState.CHECKED_IN) {
        return reject(ScanResult.REJECTED_ALREADY_CHECKED_IN)
    }

    val warnings = ArrayList<ScanWarning>()
    if (ticket.requiresProof) warnings += ScanWarning.DISCOUNT_PROOF_REQUIRED
    if (input.deviceEntranceId != null && ticket.entranceId != null && input.deviceEntranceId != ticket.entranceId) {
        warnings += ScanWarning.WRONG_ENTRANCE
    }
    if (ticket.seatFeature != null) warnings += ScanWarning.SEAT_FEATURE
    if (ticket.additionalPaymentOpen) warnings += ScanWarning.ADDITIONAL_PAYMENT_OPEN
    return ScanDecision(
        result = if (warnings.isNotEmpty()) ScanResult.ACCEPTED_WITH_WARNING else ScanResult.ACCEPTED,
        warnings = warnings,
        nextState = if (input.stale) null else CheckInState.CHECKED_IN,
    )
}

private fun reject(result: ScanResult) = ScanDecision(result, emptyList(), null)
