package org.tix.checkin.core.scan

import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.FirstScan
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanColor
import org.tix.checkin.core.contract.ScanRequest
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.ScanTicketDisplay
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.contract.SyncTicket
import org.tix.checkin.core.contract.TicketStatus

/** A ticket row of the local database (a synced `SyncTicket` plus local-only flags). */
data class LocalTicket(
    val id: String,
    val ticketCode: String,
    val status: TicketStatus,
    val eventId: String,
    val keyId: String,
    val sectionId: String,
    val sectionLabel: String,
    val rowLabel: String?,
    val seatLabel: String?,
    val seatFeature: SeatFeature?,
    val categoryId: String,
    val categoryName: String,
    val ticketTypeId: String,
    val attendeeName: String?,
    val checkInState: CheckInState,
    val firstCheckedInAt: String?,
    val firstCheckedInDeviceName: String?,
    val checkInCount: Int,
    val lastScanAt: String?,
    val additionalPaymentOpen: Boolean,
    val syncVersion: Long,
    /** Created locally from a valid signature alone (ticket not synced yet). */
    val provisional: Boolean = false,
    /** A local scan of this ticket is not uploaded yet: the local check-in state wins over a delta. */
    val localDirty: Boolean = false,
    /**
     * The check-in fields were set by a LAN master decision (or learned from the master) and the server
     * has not caught up yet: a delta row older than [lastScanAt] must not overwrite them. Unlike
     * [localDirty] there is no journal row to clear it: it clears when the server's row reaches [lastScanAt].
     */
    val lanDirty: Boolean = false,
    /** Master device only: position in the LAN change feed (0 = never changed by a scan on this device). */
    val lanSeq: Long = 0,
) {
    companion object {
        fun fromSync(t: SyncTicket) = LocalTicket(
            id = t.id, ticketCode = t.ticketCode, status = t.status, eventId = t.eventId, keyId = t.keyId,
            sectionId = t.sectionId, sectionLabel = t.sectionLabel, rowLabel = t.rowLabel, seatLabel = t.seatLabel,
            seatFeature = t.seatFeature, categoryId = t.categoryId, categoryName = t.categoryName,
            ticketTypeId = t.ticketTypeId, attendeeName = t.attendeeName, checkInState = t.checkInState,
            firstCheckedInAt = t.firstCheckedInAt, firstCheckedInDeviceName = t.firstCheckedInDeviceName,
            checkInCount = t.checkInCount, lastScanAt = t.lastScanAt,
            additionalPaymentOpen = t.additionalPaymentOpen, syncVersion = t.syncVersion,
        )
    }

    fun display(ticketTypeName: String = ""): ScanTicketDisplay = ScanTicketDisplay(
        id = id, ticketCode = ticketCode, status = status, attendeeName = attendeeName, categoryName = categoryName,
        ticketTypeName = ticketTypeName, sectionLabel = sectionLabel, rowLabel = rowLabel, seatLabel = seatLabel,
        seatFeature = seatFeature, checkInState = checkInState,
    )

    fun firstScan(): FirstScan? = firstCheckedInAt?.let { FirstScan(it, firstCheckedInDeviceName) }
}

data class TicketTypeConfig(val id: String, val name: String, val requiresProof: Boolean, val scannerWarning: String?)

/** Everything the offline decision needs about one assigned event (from the manifest). */
class EventConfig(
    val id: String,
    val title: String,
    /** Entrance this device is stationed at for the event. */
    val entranceId: String?,
    val allowCheckOut: Boolean,
    /** keyId -> raw 32-byte Ed25519 public key. Revoked keys are absent. */
    val keys: Map<String, ByteArray>,
    val ticketTypes: Map<String, TicketTypeConfig>,
    /** sectionId -> entrance of the block (null = none). */
    val sectionEntrances: Map<String, String?>,
    /** 32-byte LAN secret of the event; null = LAN sync disabled (server setting) or not delivered. */
    val lanSecret: ByteArray? = null,
)

class ConfigSnapshot(
    val offlineModeAllowed: Boolean,
    val deviceName: String,
    val events: Map<String, EventConfig>,
    val deviceId: String = "",
) {
    companion object {
        val EMPTY = ConfigSnapshot(offlineModeAllowed = true, deviceName = "", events = emptyMap())
    }
}

/** SERVER = the server; LOCAL = this device alone; LAN = the LAN master device (upload still pending). */
enum class DecidedBy { SERVER, LOCAL, LAN }

/** Why a verdict carries no scan result (nothing was recorded). */
enum class VerdictNotice { OFFLINE_NOT_ALLOWED, EVENT_NOT_ASSIGNED }

/** What the scanner UI shows after a scan. */
data class ScanVerdict(
    val clientScanId: String,
    val action: ScanAction,
    /** null only when [notice] explains why no decision was made. */
    val result: ScanResult?,
    val color: ScanColor,
    val warnings: List<ScanWarning> = emptyList(),
    val warningTexts: Map<String, String> = emptyMap(),
    val ticket: ScanTicketDisplay? = null,
    val firstScan: FirstScan? = null,
    val decidedBy: DecidedBy,
    val notice: VerdictNotice? = null,
    /** Admitted on the signature alone: the ticket is not (yet) in the local database. */
    val provisional: Boolean = false,
)

/** One scan, before it is decided. */
data class ScanCommand(
    val clientScanId: String,
    /** Event the operator is scanning (for camera scans the payload's event decides, see ScanCoordinator). */
    val eventId: String,
    val action: ScanAction,
    val source: ScanSource,
    val payload: String? = null,
    val ticketId: String? = null,
    val ticketCode: String? = null,
    val scannedAtMillis: Long,
    val entranceId: String? = null,
) {
    fun toRequest() = ScanRequest(
        clientScanId = clientScanId,
        eventId = eventId,
        action = action,
        source = source,
        payload = payload?.take(PAYLOAD_UPLOAD_MAX),
        ticketId = ticketId,
        ticketCode = ticketCode,
        scannedAt = org.tix.checkin.core.contract.Iso.format(scannedAtMillis),
        entranceId = entranceId,
    )

    companion object {
        const val PAYLOAD_UPLOAD_MAX = 2048
    }
}

/** A row of the local scan journal (append-only; only the upload fields change afterwards). */
data class JournalEntry(
    /** Local append position of the journal row (monotonic, never reused); 0 = not stored yet. */
    val rowId: Long = 0,
    val clientScanId: String,
    val eventId: String,
    val ticketId: String?,
    val ticketCode: String?,
    val payload: String?,
    val action: ScanAction,
    val source: ScanSource,
    /** Result of the decision that was shown to the operator (offline: the local decision). */
    val result: ScanResult,
    val warnings: List<ScanWarning>,
    val warningTexts: Map<String, String>,
    val scannedAtMillis: Long,
    val entranceId: String?,
    val decidedBy: DecidedBy,
    /** true = nothing (more) to upload: server-decided, outcome applied, quarantined or not recorded. */
    val uploaded: Boolean,
    /** Result the server recorded for this scan (offline scans: after the upload). */
    val serverResult: ScanResult? = null,
    /** The offline decision was positive but the server rejected the scan (e.g. already checked in). */
    val conflict: Boolean = false,
    /** Upload gave up on this scan (the server refused the request itself). */
    val uploadError: String? = null,
    // Display data for the history list.
    val attendeeName: String? = null,
    val seatLabel: String? = null,
    val categoryName: String? = null,
)

/** Database access needed by the scan authorities. Implemented with Room in the app. */
interface ScanStore {
    suspend fun ticket(id: String): LocalTicket?
    suspend fun ticketByCode(eventId: String, code: String): LocalTicket?

    /** Inserts the journal row and upserts [ticket] (when not null) in ONE transaction. */
    suspend fun commit(entry: JournalEntry, ticket: LocalTicket?)
}

/**
 * Who decides a scan: the server (online), the LAN master device (server down, master reachable) or
 * this device (everything down).
 */
interface ScanAuthority {
    suspend fun scan(command: ScanCommand): ScanVerdict
}
