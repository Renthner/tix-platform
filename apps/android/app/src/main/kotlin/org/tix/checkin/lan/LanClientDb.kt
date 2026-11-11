package org.tix.checkin.lan

import androidx.room.withTransaction
import org.tix.checkin.core.lan.LanClientStore
import org.tix.checkin.core.lan.LanTicketState
import org.tix.checkin.core.scan.JournalEntry
import org.tix.checkin.core.scan.Merge
import org.tix.checkin.data.AppSettings
import org.tix.checkin.data.TixDatabase
import org.tix.checkin.data.toCore
import org.tix.checkin.data.toEntity
import org.tix.checkin.data.toLocal

/**
 * Room + preferences implementation of the LAN client's storage needs. [applyStates] is a read-modify-write of
 * ticket rows: the caller wraps this store in `LockedLanClientStore` (shared database lock).
 */
class LanClientDb(private val db: TixDatabase, private val settings: AppSettings) : LanClientStore {
    private val dao = db.dao()

    override suspend fun cursor(masterId: String, eventId: String) = settings.lanCursor(masterId, eventId)

    override suspend fun setCursor(masterId: String, eventId: String, cursor: Long) = settings.setLanCursor(masterId, eventId, cursor)

    override suspend fun epoch(masterId: String, eventId: String) = settings.lanEpoch(masterId, eventId)

    override suspend fun setEpoch(masterId: String, eventId: String, epoch: String) = settings.setLanEpoch(masterId, eventId, epoch)

    override suspend fun applyStates(states: List<LanTicketState>) {
        db.withTransaction {
            for (s in states) {
                val merged = Merge.adoptLanState(dao.ticket(s.ticketId)?.toLocal(), s, markLocalDirty = false) ?: continue
                dao.putTicket(merged.toEntity())
            }
        }
    }

    override suspend fun unreportedLocalScans(masterId: String, eventId: String, limit: Int): List<JournalEntry> =
        dao.unreportedLocal(eventId, settings.lanReportedUpTo(masterId, eventId), limit).map { it.toCore() }

    override suspend fun markReported(masterId: String, eventId: String, entries: List<JournalEntry>) {
        val newest = entries.maxOfOrNull { it.rowId } ?: return
        if (newest > settings.lanReportedUpTo(masterId, eventId)) settings.setLanReportedUpTo(masterId, eventId, newest)
    }
}
