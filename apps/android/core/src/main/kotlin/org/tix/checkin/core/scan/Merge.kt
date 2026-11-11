package org.tix.checkin.core.scan

import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.SyncTicket
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.lan.LanTicketState

/** Pure state transitions of the local ticket rows (docs/SCANNER.md "Offline merge rules"). */
object Merge {
    /** Ticket state after a scan that was ACCEPTED locally. */
    fun afterLocalScan(ticket: LocalTicket, decision: ScanDecision, scannedAtMillis: Long, deviceName: String): LocalTicket {
        val next = decision.nextState ?: return ticket
        val at = Iso.format(scannedAtMillis)
        return if (next == CheckInState.CHECKED_IN) {
            ticket.copy(
                checkInState = next,
                checkInCount = ticket.checkInCount + 1,
                firstCheckedInAt = ticket.firstCheckedInAt ?: at,
                firstCheckedInDeviceName = if (ticket.firstCheckedInAt == null) deviceName else ticket.firstCheckedInDeviceName,
                lastScanAt = at,
                localDirty = true,
            )
        } else {
            ticket.copy(checkInState = next, lastScanAt = at, localDirty = true)
        }
    }

    /** Ticket state after the SERVER decided an online scan. Learns from the outcome only. */
    fun afterServerScan(ticket: LocalTicket?, outcome: ScanOutcome, action: ScanAction, scannedAtMillis: Long): LocalTicket? {
        if (ticket == null) return null
        val shown = outcome.ticket ?: return ticket
        var next = ticket.copy(status = shown.status, checkInState = shown.checkInState)
        outcome.firstScan?.let { next = next.copy(firstCheckedInAt = it.at, firstCheckedInDeviceName = it.deviceName) }
        if (outcome.result.isAccepted) {
            next = next.copy(lastScanAt = Iso.format(scannedAtMillis))
            if (action == ScanAction.CHECK_IN) next = next.copy(checkInCount = next.checkInCount + 1)
        }
        return next
    }

    /**
     * Applies a delta-sync row. A ticket with an unsent local scan keeps its local check-in fields
     * (the upload will make the server catch up); everything else is taken from the server, a
     * tombstone always wins.
     */
    fun mergeIncoming(existing: LocalTicket?, incoming: SyncTicket): LocalTicket {
        // Pages can repeat rows: never replace a row by an older version of itself.
        if (existing != null && !existing.provisional && existing.syncVersion > incoming.syncVersion) return existing
        val fresh = LocalTicket.fromSync(incoming)
        if (existing == null) return fresh
        val lanHold = existing.lanDirty && !serverCaughtUp(existing, incoming)
        if (!existing.localDirty && !lanHold) return fresh.copy(lanSeq = existing.lanSeq)
        if (incoming.status != TicketStatus.VALID) return fresh.copy(localDirty = existing.localDirty, lanSeq = existing.lanSeq)
        return fresh.copy(
            checkInState = existing.checkInState,
            firstCheckedInAt = existing.firstCheckedInAt ?: incoming.firstCheckedInAt,
            firstCheckedInDeviceName = if (existing.firstCheckedInAt != null) existing.firstCheckedInDeviceName else incoming.firstCheckedInDeviceName,
            checkInCount = maxOf(existing.checkInCount, incoming.checkInCount),
            lastScanAt = existing.lastScanAt ?: incoming.lastScanAt,
            localDirty = existing.localDirty,
            lanDirty = lanHold,
            lanSeq = existing.lanSeq,
        )
    }

    /** One row of a merged delta page; [lanChanged] = it must get a new position in the LAN change feed. */
    class MergedRow(val ticket: LocalTicket, val lanChanged: Boolean)

    /**
     * Merges a delta page into the local rows ([existing] by id, as stored before the page). Within a page the
     * later row of the same ticket wins (higher syncVersion). The caller stores the rows and gives every
     * [MergedRow.lanChanged] row the next LAN feed position - so a cancellation or a check-in learned from the
     * server reaches the LAN clients too.
     */
    fun mergePage(existing: Map<String, LocalTicket>, tickets: List<SyncTicket>): List<MergedRow> {
        val merged = LinkedHashMap<String, LocalTicket>()
        for (t in tickets) {
            val base = merged[t.id] ?: existing[t.id]
            merged[t.id] = mergeIncoming(base, t)
        }
        return merged.map { (id, row) -> MergedRow(row, lanRelevantChange(existing[id], row)) }
    }

    /** The server's row already contains the scan that [existing]'s LAN-learned state stems from. */
    private fun serverCaughtUp(existing: LocalTicket, incoming: SyncTicket): Boolean {
        if (incoming.status != TicketStatus.VALID) return true
        val mine = Iso.parseMillis(existing.lastScanAt) ?: return true
        val theirs = Iso.parseMillis(incoming.lastScanAt) ?: return false
        return theirs >= mine
    }

    // ─── LAN ────────────────────────────────────────────────────────────────

    /** Master side: ticket state after it decided a LAN client's scan (no journal row, see [LocalTicket.lanDirty]). */
    fun afterLanDecision(ticket: LocalTicket, decision: ScanDecision, scannedAtMillis: Long, deviceName: String): LocalTicket {
        val next = afterLocalScan(ticket, decision, scannedAtMillis, deviceName)
        return next.copy(localDirty = ticket.localDirty, lanDirty = true)
    }

    /**
     * Master side: a client reports a scan it accepted while the master was unreachable. Same stale
     * rule as the server (docs/SCANNER.md "Offline merge rules"): a scan older than the ticket's last
     * scan never changes the state; a stale check-in older than the first entry only moves the
     * first-entry info (the result - duplicate entry or, with [exitBetween], a real second entry - is
     * decided by [decideScan] exactly like the server; it only matters for the upload outcome).
     * Returns null when nothing changes. Callers apply a batch in scannedAt order.
     */
    fun afterReportedScan(
        ticket: LocalTicket,
        action: ScanAction,
        scannedAtMillis: Long,
        deviceName: String,
        exitBetween: Boolean = false,
    ): LocalTicket? {
        if (ticket.status != TicketStatus.VALID) return null
        val at = Iso.format(scannedAtMillis)
        val last = Iso.parseMillis(ticket.lastScanAt)
        val first = Iso.parseMillis(ticket.firstCheckedInAt)
        val stale = last != null && scannedAtMillis < last
        val beforeFirst = first != null && scannedAtMillis < first
        val decision = decideScan(
            DecisionInput(
                action = action,
                ticket = DecisionTicket(ticket.status, ticket.checkInState, false, null, false, null),
                deviceEntranceId = null,
                checkOutAllowed = true,
                stale = stale,
                scannedBeforeFirstEntry = beforeFirst,
                exitBetween = exitBetween && beforeFirst,
            ),
        )
        if (decision.nextState == null) {
            // Any check-in older than the recorded first entry owns the stay; the state stays.
            if (action != ScanAction.CHECK_IN || !beforeFirst) return null
            return ticket.copy(firstCheckedInAt = at, firstCheckedInDeviceName = deviceName, lanDirty = true)
        }
        return if (action == ScanAction.CHECK_IN) {
            ticket.copy(
                checkInState = CheckInState.CHECKED_IN,
                checkInCount = ticket.checkInCount + 1,
                firstCheckedInAt = ticket.firstCheckedInAt ?: at,
                firstCheckedInDeviceName = if (ticket.firstCheckedInAt == null) deviceName else ticket.firstCheckedInDeviceName,
                lastScanAt = at,
                lanDirty = true,
            )
        } else {
            ticket.copy(checkInState = CheckInState.CHECKED_OUT, lastScanAt = at, lanDirty = true)
        }
    }

    /** Master side: a scan with a valid signature for a ticket the master does not know (yet). */
    fun provisionalFromLan(eventId: String, ticketId: String, keyId: String, seatInfo: String, scannedAtMillis: Long, deviceName: String): LocalTicket {
        val at = Iso.format(scannedAtMillis)
        return LocalTicket(
            id = ticketId, ticketCode = "", status = TicketStatus.VALID, eventId = eventId, keyId = keyId,
            sectionId = "", sectionLabel = seatInfo, rowLabel = null, seatLabel = null, seatFeature = null,
            categoryId = "", categoryName = "", ticketTypeId = "", attendeeName = null,
            checkInState = CheckInState.CHECKED_IN, firstCheckedInAt = at, firstCheckedInDeviceName = deviceName,
            checkInCount = 1, lastScanAt = at, additionalPaymentOpen = false, syncVersion = 0,
            provisional = true, lanDirty = true,
        )
    }

    /**
     * Client side: take over the check-in state the master knows (answer to a scan, or the pull feed).
     * Never goes back in time: a state whose last scan is older than ours is ignored. A ticket we do not
     * have becomes a provisional row. [markLocalDirty] = our own scan is in the journal, unsent.
     */
    fun adoptLanState(existing: LocalTicket?, s: LanTicketState, markLocalDirty: Boolean): LocalTicket? {
        if (existing == null) {
            val d = s.display
            val valid = s.status == TicketStatus.VALID
            return LocalTicket(
                id = s.ticketId, ticketCode = d.ticketCode, status = s.status, eventId = s.eventId, keyId = s.keyId,
                sectionId = "", sectionLabel = d.sectionLabel, rowLabel = d.rowLabel, seatLabel = d.seatLabel,
                seatFeature = d.seatFeature, categoryId = "", categoryName = d.categoryName, ticketTypeId = "",
                attendeeName = d.attendeeName, checkInState = s.checkInState, firstCheckedInAt = s.firstCheckedInAt,
                firstCheckedInDeviceName = s.firstCheckedInDeviceName, checkInCount = s.checkInCount,
                lastScanAt = s.lastScanAt, additionalPaymentOpen = false, syncVersion = 0,
                // A void ticket learned from the master is a tombstone: the server's row replaces it later.
                provisional = true, localDirty = markLocalDirty, lanDirty = valid,
            )
        }
        if (existing.eventId != s.eventId) return null
        // Tombstones always win (checked before the time rule) and a void ticket is never revived by the LAN.
        val status = if (existing.status != TicketStatus.VALID) existing.status else s.status
        val tombstone = status != existing.status
        val mine = Iso.parseMillis(existing.lastScanAt)
        val theirs = Iso.parseMillis(s.lastScanAt)
        val newer = mine == null || (theirs != null && theirs >= mine)
        if (!newer) {
            val dirty = markLocalDirty && !existing.localDirty
            return when {
                tombstone -> existing.copy(status = status, localDirty = existing.localDirty || markLocalDirty)
                dirty -> existing.copy(localDirty = true)
                else -> null
            }
        }
        return existing.copy(
            status = status,
            checkInState = s.checkInState,
            firstCheckedInAt = s.firstCheckedInAt ?: existing.firstCheckedInAt,
            firstCheckedInDeviceName = if (s.firstCheckedInAt != null) s.firstCheckedInDeviceName else existing.firstCheckedInDeviceName,
            checkInCount = maxOf(existing.checkInCount, s.checkInCount),
            lastScanAt = s.lastScanAt ?: existing.lastScanAt,
            localDirty = existing.localDirty || markLocalDirty,
            lanDirty = true,
        )
    }

    /**
     * A change that other devices of the LAN must learn (status or check-in fields): used to number the
     * master's change feed also for rows that arrive from the server (delta sync), not only for scans.
     */
    fun lanRelevantChange(old: LocalTicket?, new: LocalTicket): Boolean {
        if (old == null) return new.status != TicketStatus.VALID || new.checkInState != CheckInState.NONE || new.checkInCount > 0
        return old.status != new.status || old.checkInState != new.checkInState ||
            old.firstCheckedInAt != new.firstCheckedInAt || old.firstCheckedInDeviceName != new.firstCheckedInDeviceName ||
            old.checkInCount != new.checkInCount || old.lastScanAt != new.lastScanAt
    }

    data class UploadMerge(val entry: JournalEntry, val ticket: LocalTicket?)

    /**
     * Applies the server's outcome for an uploaded offline scan to the journal row and the ticket.
     * [otherPending] = other unsent scans of the same ticket exist (the dirty flag stays).
     */
    fun applyOutcome(entry: JournalEntry, outcome: ScanOutcome, ticket: LocalTicket?, otherPending: Boolean): UploadMerge {
        val conflict = entry.result.isAccepted && !outcome.result.isAccepted
        val updatedEntry = entry.copy(uploaded = true, serverResult = outcome.result, conflict = conflict, uploadError = null)
        if (ticket == null) return UploadMerge(updatedEntry, null)
        var next: LocalTicket = ticket
        val shown = outcome.ticket
        if (shown != null && (conflict || shown.status != TicketStatus.VALID)) {
            // The server knows better: adopt its state (guest was already inside, ticket void, ...).
            next = next.copy(status = shown.status, checkInState = shown.checkInState)
            outcome.firstScan?.let { next = next.copy(firstCheckedInAt = it.at, firstCheckedInDeviceName = it.deviceName) }
        }
        if (!otherPending) next = next.copy(localDirty = false)
        return UploadMerge(updatedEntry, next)
    }

    /** A scan the server refused as a request (422/413 on its own): give up, keep the local state. */
    fun quarantine(entry: JournalEntry, ticket: LocalTicket?, error: String, otherPending: Boolean): UploadMerge {
        val updated = entry.copy(uploaded = true, uploadError = error.take(200))
        return UploadMerge(updated, if (ticket != null && !otherPending) ticket.copy(localDirty = false) else ticket)
    }
}
