package org.tix.checkin.core.scan

import kotlin.test.Test
import kotlin.test.assertEquals
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanColor
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.contract.TicketStatus

/** Port of packages/shared/test/scanner-decision.test.ts (decideScan). */
class DecisionTest {
    private fun ticket(
        status: TicketStatus = TicketStatus.VALID,
        state: CheckInState = CheckInState.NONE,
        requiresProof: Boolean = false,
        feature: SeatFeature? = null,
        additional: Boolean = false,
        entrance: String? = null,
    ) = DecisionTicket(status, state, requiresProof, feature, additional, entrance)

    private fun input(
        action: ScanAction = ScanAction.CHECK_IN,
        ticket: DecisionTicket? = ticket(),
        device: String? = null,
        checkOut: Boolean = true,
    ) = DecisionInput(action, ticket, device, checkOut)

    @Test
    fun `accepts a plain valid ticket (green)`() {
        val d = decideScan(input())
        assertEquals(ScanDecision(ScanResult.ACCEPTED, emptyList(), CheckInState.CHECKED_IN), d)
        assertEquals(ScanColor.GREEN, d.result.color)
    }

    @Test
    fun `collects every warning but still admits (yellow)`() {
        val d = decideScan(
            input(
                ticket = ticket(requiresProof = true, feature = SeatFeature.WHEELCHAIR_SPACE, additional = true, entrance = "north"),
                device = "south",
            ),
        )
        assertEquals(ScanResult.ACCEPTED_WITH_WARNING, d.result)
        assertEquals(CheckInState.CHECKED_IN, d.nextState)
        assertEquals(
            listOf(ScanWarning.DISCOUNT_PROOF_REQUIRED, ScanWarning.WRONG_ENTRANCE, ScanWarning.SEAT_FEATURE, ScanWarning.ADDITIONAL_PAYMENT_OPEN),
            d.warnings,
        )
        assertEquals(ScanColor.YELLOW, d.result.color)
    }

    @Test
    fun `warns about the entrance only when both sides are known and differ`() {
        fun w(device: String?, own: String?) = decideScan(input(ticket = ticket(entrance = own), device = device)).warnings
        assertEquals(emptyList(), w(null, "a"))
        assertEquals(emptyList(), w("a", null))
        assertEquals(emptyList(), w("a", "a"))
        assertEquals(listOf(ScanWarning.WRONG_ENTRANCE), w("a", "b"))
    }

    @Test
    fun `allows re-entry after a check-out`() {
        assertEquals(ScanResult.ACCEPTED, decideScan(input(ticket = ticket(state = CheckInState.CHECKED_OUT))).result)
    }

    @Test
    fun `rejects a second check-in without changing state (red)`() {
        val d = decideScan(input(ticket = ticket(state = CheckInState.CHECKED_IN)))
        assertEquals(ScanDecision(ScanResult.REJECTED_ALREADY_CHECKED_IN, emptyList(), null), d)
        assertEquals(ScanColor.RED, d.result.color)
    }

    @Test
    fun `rejects cancelled, refunded and replaced tickets as void`() {
        for (status in listOf(TicketStatus.CANCELLED, TicketStatus.REFUNDED, TicketStatus.REPLACED, TicketStatus.UNKNOWN)) {
            assertEquals(ScanResult.REJECTED_TICKET_VOID, decideScan(input(ticket = ticket(status = status))).result)
            assertEquals(
                ScanResult.REJECTED_TICKET_VOID,
                decideScan(input(action = ScanAction.CHECK_OUT, ticket = ticket(status = status))).result,
            )
        }
    }

    @Test
    fun `rejects an unknown ticket`() {
        assertEquals(ScanResult.REJECTED_UNKNOWN_TICKET, decideScan(input(ticket = null)).result)
    }

    @Test
    fun `check-out needs permission and a checked-in ticket`() {
        fun out(ticket: DecisionTicket? = ticket(), allowed: Boolean = true) =
            decideScan(input(action = ScanAction.CHECK_OUT, ticket = ticket, checkOut = allowed))
        assertEquals(
            ScanDecision(ScanResult.ACCEPTED, emptyList(), CheckInState.CHECKED_OUT),
            out(ticket(state = CheckInState.CHECKED_IN)),
        )
        assertEquals(
            ScanResult.REJECTED_CHECK_OUT_NOT_ALLOWED,
            out(ticket(state = CheckInState.CHECKED_IN), allowed = false).result,
        )
        assertEquals(ScanResult.REJECTED_NOT_CHECKED_IN, out().result)
        assertEquals(ScanResult.REJECTED_NOT_CHECKED_IN, out(ticket(state = CheckInState.CHECKED_OUT)).result)
    }

    // ─── decideScan: stale scans (late offline uploads) ───

    private fun stale(
        action: ScanAction = ScanAction.CHECK_IN,
        ticket: DecisionTicket? = ticket(),
        allowed: Boolean = true,
        before: Boolean = false,
        exitBetween: Boolean = false,
    ) = decideScan(DecisionInput(action, ticket, null, allowed, stale = true, scannedBeforeFirstEntry = before, exitBetween = exitBetween))

    private val inside get() = ticket(state = CheckInState.CHECKED_IN)
    private val outside get() = ticket(state = CheckInState.CHECKED_OUT)

    @Test
    fun `stale - never changes the state`() {
        for (t in listOf(ticket(), inside, outside)) {
            for (action in listOf(ScanAction.CHECK_IN, ScanAction.CHECK_OUT)) {
                for (before in listOf(true, false)) {
                    assertEquals(null, stale(action = action, ticket = t, before = before).nextState)
                }
            }
        }
    }

    @Test
    fun `stale - a historic check-in counts only when older than the first entry`() {
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, stale(ticket = outside, before = false).result)
        val earlier = stale(ticket = ticket(state = CheckInState.CHECKED_IN, requiresProof = true), before = true, exitBetween = true)
        assertEquals(ScanResult.ACCEPTED_WITH_WARNING, earlier.result)
        assertEquals(listOf(ScanWarning.DISCOUNT_PROOF_REQUIRED), earlier.warnings)
    }

    @Test
    fun `stale - a check-in older than the first entry without a check-out in between is a duplicate`() {
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, stale(ticket = inside, before = true, exitBetween = false).result)
    }

    @Test
    fun `stale - a historic check-out is valid when the guest had entered before it`() {
        assertEquals(ScanResult.ACCEPTED, stale(action = ScanAction.CHECK_OUT, ticket = inside, before = false).result)
        assertEquals(ScanResult.REJECTED_NOT_CHECKED_IN, stale(action = ScanAction.CHECK_OUT, ticket = inside, before = true).result)
        assertEquals(ScanResult.REJECTED_CHECK_OUT_NOT_ALLOWED, stale(action = ScanAction.CHECK_OUT, ticket = inside, allowed = false).result)
    }

    @Test
    fun `stale - void tickets stay void`() {
        assertEquals(ScanResult.REJECTED_TICKET_VOID, stale(ticket = ticket(status = TicketStatus.CANCELLED)).result)
    }
}
