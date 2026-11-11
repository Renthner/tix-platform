package org.tix.checkin.data

import androidx.room.withTransaction
import java.util.UUID
import org.tix.checkin.core.contract.Manifest
import org.tix.checkin.core.contract.ManifestCategory
import org.tix.checkin.core.contract.ManifestEntrance
import org.tix.checkin.core.contract.ManifestEvent
import org.tix.checkin.core.contract.ManifestKey
import org.tix.checkin.core.contract.ManifestLan
import org.tix.checkin.core.contract.ManifestSection
import org.tix.checkin.core.contract.ManifestSettings
import org.tix.checkin.core.contract.ManifestTicketType
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.lan.LanMasterStore
import org.tix.checkin.core.scan.ConfigBuilder
import org.tix.checkin.core.scan.ConfigSnapshot
import org.tix.checkin.core.scan.JournalEntry
import org.tix.checkin.core.scan.LocalTicket
import org.tix.checkin.core.scan.Merge
import org.tix.checkin.core.scan.ScanStore
import org.tix.checkin.core.sync.JournalUploadStore
import org.tix.checkin.core.sync.TicketSyncStore

/** The sync epoch of the server changed in the middle of a sync run: wipe and start over. */
class SyncEpochChangedException(val newEpoch: String) : Exception("sync epoch changed to $newEpoch")

/**
 * Room implementation of every store interface of :core. Callers hold the shared database lock (dbLock) for
 * every read-modify-write of ticket rows: the scan authorities around [commit] / [commitLan], and the
 * `Locked*Store` wrappers of :core around [applyPage], [applyOutcome] and [quarantine]. The lock is taken first,
 * the Room transaction second - never the other way round.
 */
class RoomStore(
    private val db: TixDatabase,
    /** Version code of the running app: stored with a quarantined scan, which is retried after an update. */
    private val appVersion: Int = 0,
    /** Forget the LAN cursors of all masters (called together with [resetSyncData]). */
    private val clearLanCursors: () -> Unit = {},
) : ScanStore, JournalUploadStore, TicketSyncStore, LanMasterStore {
    private val dao = db.dao()

    /** Hands out [n] consecutive LAN feed positions from the persistent counter. Inside a transaction. */
    private suspend fun reserveLanSeq(n: Int): Long {
        dao.insertLanState(LanStateEntity(seq = 0, epoch = UUID.randomUUID().toString()))
        dao.bumpLanSeq(n)
        return (dao.lanSeqValue() ?: 0L) - n + 1
    }

    // ─── ScanStore ───
    override suspend fun ticket(id: String) = dao.ticket(id)?.toLocal()

    override suspend fun ticketByCode(eventId: String, code: String) = dao.ticketByCode(eventId, code)?.toLocal()

    override suspend fun commit(entry: JournalEntry, ticket: LocalTicket?) {
        db.withTransaction {
            dao.insertJournal(entry.toEntity())
            // Every state change gets a position in the LAN change feed (only a master serves it).
            if (ticket != null) dao.putTicket(ticket.copy(lanSeq = reserveLanSeq(1)).toEntity())
        }
    }

    // ─── LanMasterStore ───
    override suspend fun commitLan(ticket: LocalTicket) {
        db.withTransaction { dao.putTicket(ticket.copy(lanSeq = reserveLanSeq(1)).toEntity()) }
    }

    override suspend fun changedSince(eventId: String, seq: Long, limit: Int) =
        dao.changedSince(eventId, seq, limit).map { it.toLocal() }

    override suspend fun maxLanSeq(): Long = dao.lanSeqValue() ?: 0L

    /** Read only; the row is created once at app start ([ensureLanState]) and by the first reservation. */
    override suspend fun lanEpoch(): String = dao.lanEpochValue().orEmpty()

    /** Creates the LAN counter row (new epoch) when missing: at app start and after a wipe. */
    suspend fun ensureLanState() {
        dao.insertLanState(LanStateEntity(seq = 0, epoch = UUID.randomUUID().toString()))
    }

    // ─── JournalUploadStore ───
    override suspend fun pending(limit: Int) = dao.pendingJournal(limit).map { it.toCore() }

    override suspend fun applyOutcome(entry: JournalEntry, outcome: ScanOutcome) {
        db.withTransaction {
            val ticketId = entry.ticketId ?: outcome.ticket?.id
            val ticket = ticketId?.let { dao.ticket(it)?.toLocal() }
            val other = ticketId?.let { dao.otherPending(it, entry.clientScanId) > 0 } ?: false
            val merged = Merge.applyOutcome(entry, outcome, ticket, other)
            val e = merged.entry
            dao.updateJournalUpload(e.clientScanId, e.uploaded, e.serverResult?.name, e.conflict, e.uploadError)
            merged.ticket?.let { dao.putTicket(it.toEntity()) }
        }
    }

    override suspend fun quarantine(entry: JournalEntry, error: String) {
        db.withTransaction {
            val ticket = entry.ticketId?.let { dao.ticket(it)?.toLocal() }
            val other = entry.ticketId?.let { dao.otherPending(it, entry.clientScanId) > 0 } ?: false
            val merged = Merge.quarantine(entry, ticket, error, other)
            val e = merged.entry
            dao.updateJournalUpload(e.clientScanId, e.uploaded, e.serverResult?.name, e.conflict, e.uploadError)
            dao.setQuarantineVersion(e.clientScanId, appVersion)
            merged.ticket?.let { dao.putTicket(it.toEntity()) }
        }
    }

    override suspend fun requeueQuarantined(appVersion: Int) = dao.requeueQuarantined(appVersion)

    // ─── TicketSyncStore ───
    override suspend fun cursor(eventId: String) = dao.syncState(eventId)?.cursor?.takeIf { it.isNotEmpty() }

    override suspend fun applyPage(eventId: String, page: SyncPage) {
        db.withTransaction {
            val storedEpoch = dao.deviceConfig()?.syncEpoch
            val pageEpoch = page.syncEpoch
            if (pageEpoch != null && storedEpoch != null && pageEpoch != storedEpoch) {
                throw SyncEpochChangedException(pageEpoch)
            }
            if (pageEpoch != null && storedEpoch == null) {
                dao.deviceConfig()?.let { dao.putDeviceConfig(it.copy(syncEpoch = pageEpoch)) }
            }
            val existing = page.tickets.chunked(500).flatMap { chunk -> dao.ticketsByIds(chunk.map { it.id }) }
                .associate { it.id to it.toLocal() }
            // Within a page the later row of the same ticket wins (higher syncVersion), see Merge. A status or
            // check-in change learned from the server also gets a LAN feed position, so the master's clients learn it.
            val rows = Merge.mergePage(existing, page.tickets)
            val changed = rows.count { it.lanChanged }
            var seq = if (changed > 0) reserveLanSeq(changed) else 0L
            dao.putTickets(rows.map { r -> (if (r.lanChanged) r.ticket.copy(lanSeq = seq++) else r.ticket).toEntity() })
            dao.putSyncState(SyncStateEntity(eventId, page.nextCursor, System.currentTimeMillis()))
        }
    }

    /**
     * Drops synced tickets + cursors (epoch change, forced resync); unsent local scans and LAN-learned state the
     * server has not seen stay, and so does the LAN counter. The LAN cursors of all masters are cleared in the same reset.
     */
    suspend fun resetSyncData(newEpoch: String?) {
        db.withTransaction {
            dao.deleteCleanTickets()
            dao.clearSyncStates()
            dao.deviceConfig()?.let { dao.putDeviceConfig(it.copy(syncEpoch = newEpoch ?: it.syncEpoch)) }
        }
        clearLanCursors()
    }
}

/** Manifest persistence and the in-memory [ConfigSnapshot] used by the offline decision. */
class ConfigRepository(private val db: TixDatabase) {
    private val dao = db.dao()

    @Volatile
    var snapshot: ConfigSnapshot = ConfigSnapshot.EMPTY
        private set

    /** Rebuilds [snapshot] from the database (app start, after every manifest change). */
    suspend fun reload() {
        val cfg = dao.deviceConfig()
        if (cfg == null) {
            snapshot = ConfigSnapshot.EMPTY
            return
        }
        snapshot = ConfigBuilder.build(cfg.deviceName, settingsOf(cfg), manifestEvents(), cfg.deviceId)
    }

    fun settingsOf(c: DeviceConfigEntity) = ManifestSettings(
        c.offlineModeAllowed, c.lanSyncEnabled, c.syncIntervalSeconds,
    )

    suspend fun manifestEvents(): List<ManifestEvent> {
        val keys = dao.keys().groupBy { it.eventId }
        val types = dao.ticketTypes().groupBy { it.eventId }
        val cats = dao.categories().groupBy { it.eventId }
        val ents = dao.entrances().groupBy { it.eventId }
        val secs = dao.sections().groupBy { it.eventId }
        return dao.events().map { e ->
            ManifestEvent(
                id = e.id, title = e.title, subtitle = e.subtitle, startsAt = e.startsAt, doorsOpenAt = e.doorsOpenAt,
                endsAt = e.endsAt, timeZone = e.timeZone, venueName = e.venueName, entranceId = e.entranceId,
                allowCheckOut = e.allowCheckOut,
                keys = keys[e.id].orEmpty().map { ManifestKey(it.keyId, enumOr(it.status, org.tix.checkin.core.contract.KeyStatus.REVOKED), it.publicKey) },
                ticketTypes = types[e.id].orEmpty().map { ManifestTicketType(it.id, it.name, it.requiresProof, it.scannerWarning) },
                categories = cats[e.id].orEmpty().map { ManifestCategory(it.id, it.name, it.color) },
                entrances = ents[e.id].orEmpty().map { ManifestEntrance(it.id, it.name, it.code) },
                sections = secs[e.id].orEmpty().map { ManifestSection(it.id, it.name, it.entranceId) },
                lan = ManifestLan(e.lanEnabled, e.lanSecret),
            )
        }
    }

    /**
     * Stores the manifest. Events that disappeared lose their local ticket data (the unsent scan
     * journal stays). Returns the ids of removed events.
     */
    suspend fun applyManifest(manifest: Manifest, clockOffsetMs: Long): List<String> {
        val removed = db.withTransaction {
            val cfg = dao.deviceConfig() ?: return@withTransaction emptyList()
            val newIds = manifest.events.map { it.id }.toSet()
            val gone = dao.events().map { it.id }.filter { it !in newIds }
            gone.forEach { dropEvent(it) }
            for (e in manifest.events) {
                dao.deleteKeys(e.id); dao.deleteTicketTypes(e.id); dao.deleteCategories(e.id)
                dao.deleteEntrances(e.id); dao.deleteSections(e.id)
            }
            dao.putEvents(
                manifest.events.map {
                    EventEntity(
                        it.id, it.title, it.subtitle, it.startsAt, it.doorsOpenAt, it.endsAt, it.timeZone, it.venueName,
                        it.entranceId, it.allowCheckOut, it.lan.enabled, it.lan.secret,
                    )
                },
            )
            // REVOKED keys (publicKey = null) are not stored: tickets signed with them stay invalid.
            dao.putKeys(
                manifest.events.flatMap { e ->
                    e.keys.filter { it.publicKey != null }.map { KeyEntity(e.id, it.keyId, it.status.name, it.publicKey) }
                },
            )
            dao.putTicketTypes(manifest.events.flatMap { e -> e.ticketTypes.map { TicketTypeEntity(e.id, it.id, it.name, it.requiresProof, it.scannerWarning) } })
            dao.putCategories(manifest.events.flatMap { e -> e.categories.map { CategoryEntity(e.id, it.id, it.name, it.color) } })
            dao.putEntrances(manifest.events.flatMap { e -> e.entrances.map { EntranceEntity(e.id, it.id, it.name, it.code) } })
            dao.putSections(manifest.events.flatMap { e -> e.sections.map { SectionEntity(e.id, it.id, it.name, it.entranceId) } })
            val s = manifest.settings
            dao.putDeviceConfig(
                cfg.copy(
                    deviceName = manifest.device.name,
                    offlineModeAllowed = s.offlineModeAllowed, lanSyncEnabled = s.lanSyncEnabled,
                    syncIntervalSeconds = s.syncIntervalSeconds,
                    manifestEtag = manifest.etag, clockOffsetMs = clockOffsetMs, lastManifestAt = System.currentTimeMillis(),
                ),
            )
            gone
        }
        reload()
        return removed
    }

    /** The server no longer lets this device scan the event (403 EVENT_NOT_ASSIGNED, removed in the manifest). */
    suspend fun dropEvent(eventId: String) {
        dao.deleteKeys(eventId); dao.deleteTicketTypes(eventId); dao.deleteCategories(eventId)
        dao.deleteEntrances(eventId); dao.deleteSections(eventId); dao.deleteTickets(eventId)
        dao.deleteSyncState(eventId); dao.deleteEvent(eventId)
    }

    suspend fun dropEventAndReload(eventId: String) {
        db.withTransaction { dropEvent(eventId) }
        // The ETag no longer describes the stored data: fetch the manifest again next time.
        dao.deviceConfig()?.let { dao.putDeviceConfig(it.copy(manifestEtag = null)) }
        reload()
    }

    /** Pairing/unpair: removes everything (tokens, tickets, journal). */
    suspend fun wipeAll() {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { db.clearAllTables() }
        snapshot = ConfigSnapshot.EMPTY
    }
}
