package org.tix.checkin.data

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Dao
interface TixDao {
    // ─── device config ───
    @Query("SELECT * FROM device_config WHERE id = 1")
    suspend fun deviceConfig(): DeviceConfigEntity?

    @Query("SELECT * FROM device_config WHERE id = 1")
    fun deviceConfigFlow(): Flow<DeviceConfigEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putDeviceConfig(config: DeviceConfigEntity)

    @Query("UPDATE device_config SET unpairPending = :pending, unpairNotice = :notice WHERE id = 1")
    suspend fun setUnpairBlock(pending: Boolean, notice: String?)

    // ─── manifest data ───
    @Query("SELECT * FROM events ORDER BY startsAt")
    suspend fun events(): List<EventEntity>

    @Query("SELECT * FROM events ORDER BY startsAt")
    fun eventsFlow(): Flow<List<EventEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putEvents(items: List<EventEntity>)

    @Query("SELECT * FROM event_keys")
    suspend fun keys(): List<KeyEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putKeys(items: List<KeyEntity>)

    @Query("SELECT * FROM ticket_types")
    suspend fun ticketTypes(): List<TicketTypeEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putTicketTypes(items: List<TicketTypeEntity>)

    @Query("SELECT * FROM categories")
    suspend fun categories(): List<CategoryEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putCategories(items: List<CategoryEntity>)

    @Query("SELECT * FROM entrances")
    fun entrancesFlow(): Flow<List<EntranceEntity>>

    @Query("SELECT * FROM entrances")
    suspend fun entrances(): List<EntranceEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putEntrances(items: List<EntranceEntity>)

    @Query("SELECT * FROM sections")
    suspend fun sections(): List<SectionEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putSections(items: List<SectionEntity>)

    /** Removes the manifest rows of one event (before they are re-inserted or the event is dropped). */
    @Query("DELETE FROM event_keys WHERE eventId = :eventId")
    suspend fun deleteKeys(eventId: String)

    @Query("DELETE FROM ticket_types WHERE eventId = :eventId")
    suspend fun deleteTicketTypes(eventId: String)

    @Query("DELETE FROM categories WHERE eventId = :eventId")
    suspend fun deleteCategories(eventId: String)

    @Query("DELETE FROM entrances WHERE eventId = :eventId")
    suspend fun deleteEntrances(eventId: String)

    @Query("DELETE FROM sections WHERE eventId = :eventId")
    suspend fun deleteSections(eventId: String)

    @Query("DELETE FROM events WHERE id = :eventId")
    suspend fun deleteEvent(eventId: String)

    @Query("DELETE FROM tickets WHERE eventId = :eventId")
    suspend fun deleteTickets(eventId: String)

    @Query("DELETE FROM sync_state WHERE eventId = :eventId")
    suspend fun deleteSyncState(eventId: String)

    // ─── sync ───
    @Query("SELECT * FROM sync_state WHERE eventId = :eventId")
    suspend fun syncState(eventId: String): SyncStateEntity?

    @Query("SELECT * FROM sync_state")
    fun syncStatesFlow(): Flow<List<SyncStateEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putSyncState(state: SyncStateEntity)

    @Query("DELETE FROM sync_state")
    suspend fun clearSyncStates()

    @Query("UPDATE sync_state SET cursor = NULL")
    suspend fun resetCursors()

    /**
     * Epoch change / forced resync: drop everything the server can send again, keep what only this device (or
     * the LAN) knows: unsent local scans and check-in state learned from the LAN master that the server has not seen.
     */
    @Query("DELETE FROM tickets WHERE localDirty = 0 AND lanDirty = 0")
    suspend fun deleteCleanTickets()

    // ─── tickets ───
    @Query("SELECT * FROM tickets WHERE id = :id")
    suspend fun ticket(id: String): TicketEntity?

    @Query("SELECT * FROM tickets WHERE id IN (:ids)")
    suspend fun ticketsByIds(ids: List<String>): List<TicketEntity>

    @Query("SELECT * FROM tickets WHERE eventId = :eventId AND ticketCode = :code LIMIT 1")
    suspend fun ticketByCode(eventId: String, code: String): TicketEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putTicket(ticket: TicketEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putTickets(tickets: List<TicketEntity>)

    @Query(
        "SELECT * FROM tickets WHERE eventId = :eventId AND (attendeeName LIKE '%' || :token || '%' " +
            "OR ticketCode LIKE '%' || :norm || '%' OR sectionLabel LIKE '%' || :token || '%' " +
            "OR rowLabel LIKE '%' || :token || '%' OR seatLabel LIKE '%' || :token || '%') " +
            "ORDER BY (status = 'VALID') DESC, attendeeName LIMIT 400",
    )
    suspend fun searchTickets(eventId: String, token: String, norm: String): List<TicketEntity>

    @Query("SELECT COUNT(*) FROM tickets WHERE eventId = :eventId AND status = 'VALID'")
    fun validCount(eventId: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM tickets WHERE eventId = :eventId AND status = 'VALID' AND checkInState = 'CHECKED_IN'")
    fun checkedInCount(eventId: String): Flow<Int>

    @Query("SELECT eventId, COUNT(*) AS valid FROM tickets WHERE status = 'VALID' GROUP BY eventId")
    fun validCountsFlow(): Flow<List<EventCount>>

    // ─── LAN ───
    @Query("SELECT * FROM tickets WHERE eventId = :eventId AND lanSeq > :seq ORDER BY lanSeq LIMIT :limit")
    suspend fun changedSince(eventId: String, seq: Long, limit: Int): List<TicketEntity>

    /** Creates the counter row (new generation) when missing. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertLanState(state: LanStateEntity): Long

    @Query("UPDATE lan_state SET seq = seq + :n WHERE id = 1")
    suspend fun bumpLanSeq(n: Int)

    @Query("SELECT seq FROM lan_state WHERE id = 1")
    suspend fun lanSeqValue(): Long?

    @Query("SELECT epoch FROM lan_state WHERE id = 1")
    suspend fun lanEpochValue(): String?

    /** Offline decisions of this device with journal position > [since]: reported to the LAN master. */
    @Query("SELECT * FROM scan_journal WHERE decidedBy = 'LOCAL' AND eventId = :eventId AND seq > :since ORDER BY seq LIMIT :limit")
    suspend fun unreportedLocal(eventId: String, since: Long, limit: Int): List<JournalEntity>

    // ─── journal ───
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertJournal(entry: JournalEntity)

    @Query("UPDATE scan_journal SET uploaded = :uploaded, serverResult = :serverResult, conflict = :conflict, uploadError = :error WHERE clientScanId = :id")
    suspend fun updateJournalUpload(id: String, uploaded: Boolean, serverResult: String?, conflict: Boolean, error: String?)

    @Query("UPDATE scan_journal SET quarantineVersion = :version WHERE clientScanId = :id")
    suspend fun setQuarantineVersion(id: String, version: Int)

    /** Quarantined by another app version than [version]: uploadable again (an update may fix what the server refused). */
    @Query("UPDATE scan_journal SET uploaded = 0, uploadError = NULL WHERE uploaded = 1 AND uploadError IS NOT NULL AND quarantineVersion != :version")
    suspend fun requeueQuarantined(version: Int)

    /** Everything the server never got: unsent plus quarantined scans (export before an unpair wipes them). */
    @Query("SELECT * FROM scan_journal WHERE uploaded = 0 OR uploadError IS NOT NULL ORDER BY seq")
    suspend fun unsentJournal(): List<JournalEntity>

    @Query("SELECT COUNT(*) FROM scan_journal WHERE uploaded = 0 OR uploadError IS NOT NULL")
    suspend fun unsentCount(): Int

    @Query("SELECT COUNT(*) FROM scan_journal WHERE uploaded = 1 AND uploadError IS NOT NULL")
    fun quarantinedCountFlow(): Flow<Int>

    @Query("SELECT * FROM scan_journal WHERE uploaded = 0 ORDER BY scannedAtMillis, seq LIMIT :limit")
    suspend fun pendingJournal(limit: Int): List<JournalEntity>

    @Query("SELECT COUNT(*) FROM scan_journal WHERE uploaded = 0 AND ticketId = :ticketId AND clientScanId != :exceptId")
    suspend fun otherPending(ticketId: String, exceptId: String): Int

    @Query("SELECT COUNT(*) FROM scan_journal WHERE uploaded = 0")
    fun pendingCountFlow(): Flow<Int>

    @Query("SELECT * FROM scan_journal ORDER BY scannedAtMillis DESC, seq DESC LIMIT 500")
    fun recentJournal(): Flow<List<JournalEntity>>

    // ─── wipe ───
    @Query("DELETE FROM scan_journal")
    suspend fun clearJournal()

    @Query("DELETE FROM tickets")
    suspend fun clearTickets()

    @Query("DELETE FROM events")
    suspend fun clearEvents()

    @Query("DELETE FROM device_config")
    suspend fun clearDeviceConfig()
}

data class EventCount(val eventId: String, val valid: Int)

@Database(
    entities = [
        DeviceConfigEntity::class, EventEntity::class, KeyEntity::class, TicketTypeEntity::class,
        CategoryEntity::class, EntranceEntity::class, SectionEntity::class, SyncStateEntity::class,
        TicketEntity::class, JournalEntity::class, LanStateEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class TixDatabase : RoomDatabase() {
    abstract fun dao(): TixDao
}
