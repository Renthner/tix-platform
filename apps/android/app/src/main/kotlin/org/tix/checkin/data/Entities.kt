package org.tix.checkin.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.FtsOptions
import androidx.room.Index
import androidx.room.PrimaryKey
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.ScannerJson
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.scan.DecidedBy
import org.tix.checkin.core.scan.JournalEntry
import org.tix.checkin.core.scan.LocalSearch
import org.tix.checkin.core.scan.LocalTicket

/** Single row (id = 1): pairing data, manifest settings, ETag and the learned server clock offset. */
@Entity(tableName = "device_config")
data class DeviceConfigEntity(
    @PrimaryKey val id: Int = 1,
    val serverUrl: String,
    val deviceId: String,
    val deviceName: String,
    /** AES/GCM ciphertext (Android Keystore key), never the plain token. */
    val tokenCipher: String,
    val offlineModeAllowed: Boolean = true,
    val lanSyncEnabled: Boolean = false,
    val syncIntervalSeconds: Int = 30,
    val manifestEtag: String? = null,
    val syncEpoch: String? = null,
    val clockOffsetMs: Long = 0,
    val lastManifestAt: Long = 0,
    /** An unpair waits for the operator (unsent scans exist): survives an app restart. */
    @ColumnInfo(defaultValue = "0") val unpairPending: Boolean = false,
    val unpairNotice: String? = null,
    /** Result colours + warning priority of the manifest as JSON ([org.tix.checkin.core.scan.StoredResultStyle]); null = defaults. Added in DB v2. */
    val resultStyleJson: String? = null,
)

@Entity(tableName = "events")
data class EventEntity(
    @PrimaryKey val id: String,
    val title: String,
    val subtitle: String?,
    val startsAt: String,
    val doorsOpenAt: String?,
    val endsAt: String?,
    val timeZone: String,
    val venueName: String,
    val entranceId: String?,
    val allowCheckOut: Boolean,
    val lanEnabled: Boolean,
    val lanSecret: String?,
)

@Entity(tableName = "event_keys", primaryKeys = ["eventId", "keyId"])
data class KeyEntity(val eventId: String, val keyId: String, val status: String, val publicKey: String?)

@Entity(tableName = "ticket_types", primaryKeys = ["eventId", "id"])
data class TicketTypeEntity(
    val eventId: String,
    val id: String,
    val name: String,
    val requiresProof: Boolean,
    val scannerWarning: String?,
)

@Entity(tableName = "categories", primaryKeys = ["eventId", "id"])
data class CategoryEntity(val eventId: String, val id: String, val name: String, val color: String)

@Entity(tableName = "entrances", primaryKeys = ["eventId", "id"])
data class EntranceEntity(val eventId: String, val id: String, val name: String, val code: String)

/** Block -> entrance map (WRONG_ENTRANCE warning). */
@Entity(tableName = "sections", primaryKeys = ["eventId", "id"])
data class SectionEntity(val eventId: String, val id: String, val name: String, val entranceId: String?)

@Entity(tableName = "sync_state")
data class SyncStateEntity(@PrimaryKey val eventId: String, val cursor: String?, val lastSyncAt: Long)

@Entity(
    tableName = "tickets",
    indices = [
        Index("eventId", "checkInState"),
        Index("ticketCode"),
        Index("attendeeName"),
        Index("localDirty"),
        Index("eventId", "lanSeq"),
    ],
)
data class TicketEntity(
    @PrimaryKey val id: String,
    val ticketCode: String,
    val status: String,
    val eventId: String,
    val keyId: String,
    val sectionId: String,
    val sectionLabel: String,
    val rowLabel: String?,
    val seatLabel: String?,
    val seatFeature: String?,
    val categoryId: String,
    val categoryName: String,
    val ticketTypeId: String,
    val attendeeName: String?,
    val checkInState: String,
    val firstCheckedInAt: String?,
    val firstCheckedInDeviceName: String?,
    val checkInCount: Int,
    val lastScanAt: String?,
    val additionalPaymentOpen: Boolean,
    val syncVersion: Long,
    val provisional: Boolean,
    val localDirty: Boolean,
    @ColumnInfo(defaultValue = "0") val lanDirty: Boolean = false,
    @ColumnInfo(defaultValue = "0") val lanSeq: Long = 0,
    /** Order number delivered by the sync (null until synced by a server that has it). Added in DB v3. */
    val orderNumber: String? = null,
    /**
     * Folded text of everything searchable (name, code, block, row, seat, order number): the column the full-text index
     * is built on, computed by [LocalSearch.indexText]. It follows the other fields only when the entity is built
     * (`LocalTicket.toEntity()`), never through `copy`. Added in DB v3.
     */
    @ColumnInfo(defaultValue = "''")
    val searchText: String = LocalSearch.indexText(attendeeName, ticketCode, sectionLabel, rowLabel, seatLabel, orderNumber),
)

/**
 * Full-text index over [TicketEntity.searchText] (manual lookup, 10k+ tickets). Content-backed: Room keeps it in sync
 * with `tickets` through triggers (insert/update/delete), nothing is stored twice. The text is folded in Kotlin
 * ([LocalSearch.fold]: case, diacritics, and the letters unicode61 cannot decompose such as ø, æ, ß, ł) so the
 * database and the exact filter agree; unicode61 then only splits words.
 * Tickets must be written with an UPSERT, never INSERT OR REPLACE: a REPLACE deletes the old row without firing the
 * delete trigger (recursive triggers are off) and its rowid could be reused.
 */
@Fts4(contentEntity = TicketEntity::class, tokenizer = FtsOptions.TOKENIZER_UNICODE61)
@Entity(tableName = "tickets_fts")
data class TicketFtsEntity(
    val searchText: String,
)

/**
 * LAN change feed counter of this device (single row). Lives in its own table, not in [DeviceConfigEntity]:
 * that row is rewritten as a whole by several code paths, which could lose increments. [seq] only ever grows
 * (positions are never reused after rows were deleted), [epoch] names the counter's generation: it is created
 * with the row, so wiping the database (unpair) starts a new generation and LAN clients drop their cursors.
 */
@Entity(tableName = "lan_state")
data class LanStateEntity(@PrimaryKey val id: Int = 1, val seq: Long, val epoch: String)

/**
 * LAN master: the answer given to a client's scan (`<deviceId>/<clientScanId>` -> response JSON), so a retry after a
 * restart of the master gets the same answer instead of "already checked in". Bounded (newest [MAX_ROWS] kept),
 * written in the same transaction as the ticket state. Added in DB v4.
 */
@Entity(tableName = "lan_scan_answers", indices = [Index(value = ["answerKey"], unique = true)])
data class LanScanAnswerEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val answerKey: String,
    val response: String,
    val createdAt: Long,
) {
    companion object {
        const val MAX_ROWS = 5_000L
    }
}

@Entity(
    tableName = "scan_journal",
    indices = [
        Index("uploaded", "scannedAtMillis"), Index("ticketId"), Index("eventId", "scannedAtMillis"),
        Index(value = ["clientScanId"], unique = true),
    ],
)
data class JournalEntity(
    /** Append position: monotonic and never reused (the LAN push watermark counts these, not scan times). */
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val clientScanId: String,
    val eventId: String,
    val ticketId: String?,
    val ticketCode: String?,
    val payload: String?,
    val action: String,
    val source: String,
    val result: String,
    /** Comma separated [ScanWarning] names. */
    val warnings: String,
    /** JSON object code -> text. */
    val warningTexts: String,
    val scannedAtMillis: Long,
    val entranceId: String?,
    val decidedBy: String,
    val uploaded: Boolean,
    val serverResult: String?,
    val conflict: Boolean,
    val uploadError: String?,
    val attendeeName: String?,
    val seatLabel: String?,
    val categoryName: String?,
    /** App version code under which the scan was quarantined (0 = not quarantined): retried after an update. */
    @ColumnInfo(defaultValue = "0") val quarantineVersion: Int = 0,
)

// ─── Mapping ────────────────────────────────────────────────────────────────

fun LocalTicket.toEntity() = TicketEntity(
    id, ticketCode, status.name, eventId, keyId, sectionId, sectionLabel, rowLabel, seatLabel, seatFeature?.name,
    categoryId, categoryName, ticketTypeId, attendeeName, checkInState.name, firstCheckedInAt,
    firstCheckedInDeviceName, checkInCount, lastScanAt, additionalPaymentOpen, syncVersion, provisional, localDirty,
    lanDirty, lanSeq, orderNumber,
)

fun TicketEntity.toLocal() = LocalTicket(
    id = id, ticketCode = ticketCode, status = enumOr(status, TicketStatus.UNKNOWN), eventId = eventId, keyId = keyId,
    sectionId = sectionId, sectionLabel = sectionLabel, rowLabel = rowLabel, seatLabel = seatLabel,
    seatFeature = seatFeature?.let { enumOr(it, SeatFeature.OTHER) }, categoryId = categoryId,
    categoryName = categoryName, ticketTypeId = ticketTypeId, attendeeName = attendeeName,
    checkInState = enumOr(checkInState, CheckInState.NONE), firstCheckedInAt = firstCheckedInAt,
    firstCheckedInDeviceName = firstCheckedInDeviceName, checkInCount = checkInCount, lastScanAt = lastScanAt,
    additionalPaymentOpen = additionalPaymentOpen, syncVersion = syncVersion, provisional = provisional,
    localDirty = localDirty, lanDirty = lanDirty, lanSeq = lanSeq, orderNumber = orderNumber,
)

fun JournalEntry.toEntity() = JournalEntity(
    seq = 0, // assigned by the database on insert
    clientScanId = clientScanId, eventId = eventId, ticketId = ticketId, ticketCode = ticketCode, payload = payload,
    action = action.name, source = source.name, result = result.name,
    warnings = warnings.joinToString(",") { it.name }, warningTexts = ScannerJson.encodeToString(warningTexts),
    scannedAtMillis = scannedAtMillis, entranceId = entranceId, decidedBy = decidedBy.name, uploaded = uploaded,
    serverResult = serverResult?.name, conflict = conflict, uploadError = uploadError, attendeeName = attendeeName,
    seatLabel = seatLabel, categoryName = categoryName,
)

fun JournalEntity.toCore() = JournalEntry(
    rowId = seq,
    clientScanId = clientScanId, eventId = eventId, ticketId = ticketId, ticketCode = ticketCode, payload = payload,
    action = enumOr(action, ScanAction.CHECK_IN), source = enumOr(source, ScanSource.CAMERA),
    result = enumOr(result, ScanResult.UNKNOWN),
    warnings = warnings.split(',').filter { it.isNotEmpty() }.map { enumOr(it, ScanWarning.UNKNOWN) },
    warningTexts = runCatching { ScannerJson.decodeFromString<Map<String, String>>(warningTexts) }.getOrDefault(emptyMap()),
    scannedAtMillis = scannedAtMillis, entranceId = entranceId, decidedBy = enumOr(decidedBy, DecidedBy.LOCAL),
    uploaded = uploaded, serverResult = serverResult?.let { enumOr(it, ScanResult.UNKNOWN) }, conflict = conflict,
    uploadError = uploadError, attendeeName = attendeeName, seatLabel = seatLabel, categoryName = categoryName,
)

inline fun <reified T : Enum<T>> enumOr(name: String, fallback: T): T =
    enumValues<T>().firstOrNull { it.name == name } ?: fallback
