package org.tix.checkin.core.lan

import java.security.MessageDigest
import kotlinx.serialization.Serializable
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.FirstScan
import org.tix.checkin.core.contract.ScanRequest
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanTicketDisplay
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.TicketStatus

/** LAN protocol, version 1. Bodies are JSON ([org.tix.checkin.core.contract.ScannerJson]) inside the encrypted envelope. */
object LanPaths {
    const val PREFIX = "/lan/v1"
    const val HELLO = "$PREFIX/hello"
    const val SCAN = "$PREFIX/scan"
    const val SCANS = "$PREFIX/scans"
    const val SYNC = "$PREFIX/sync"
}

const val LAN_PROTOCOL_VERSION = 1
const val LAN_SERVICE_TYPE = "_tixscan._tcp"
const val LAN_DEFAULT_PORT = 47800

@Serializable
data class LanHelloRequest(val deviceName: String = "")

@Serializable
data class LanHello(
    val protocol: Int = LAN_PROTOCOL_VERSION,
    val deviceId: String,
    val deviceName: String,
    /** Events this master serves (it holds their LAN secret). */
    val events: List<String> = emptyList(),
)

/** A scan made at a LAN client; the master decides it (it verifies the signature itself). */
@Serializable
data class LanScanRequest(val scan: ScanRequest, val deviceName: String)

/** Check-in state of one ticket as the master knows it. */
@Serializable
data class LanTicketState(
    val ticketId: String,
    val eventId: String,
    val keyId: String = "",
    val status: TicketStatus = TicketStatus.VALID,
    val checkInState: CheckInState = CheckInState.NONE,
    val firstCheckedInAt: String? = null,
    val firstCheckedInDeviceName: String? = null,
    val checkInCount: Int = 0,
    val lastScanAt: String? = null,
    /** Position in the master's change feed (0 in scan answers). */
    val seq: Long = 0,
    /** Display data, used by a client that does not have the ticket row. */
    val display: ScanTicketDisplay,
)

@Serializable
data class LanScanResponse(
    val clientScanId: String,
    /** null only when [notice] explains why nothing was decided. */
    val result: ScanResult? = null,
    val notice: String? = null,
    val warnings: List<ScanWarning> = emptyList(),
    val warningTexts: Map<String, String> = emptyMap(),
    val ticket: ScanTicketDisplay? = null,
    val firstScan: FirstScan? = null,
    val state: LanTicketState? = null,
    val provisional: Boolean = false,
)

@Serializable
data class LanSyncRequest(val eventId: String, val cursor: Long = 0, val limit: Int = 200)

@Serializable
data class LanSyncResponse(
    val changes: List<LanTicketState> = emptyList(),
    val nextCursor: Long = 0,
    val hasMore: Boolean = false,
    /** Highest position of the master's feed: a client cursor above it is stale (master database was reset). */
    val maxCursor: Long = 0,
    /** Generation of the master's counter: a client whose stored value differs restarts at cursor 0. */
    val epoch: String = "",
)

/** A scan the client decided alone (master unreachable) and now reports. */
@Serializable
data class LanReportedScan(val scan: ScanRequest, val result: ScanResult)

@Serializable
data class LanPushRequest(val deviceName: String, val scans: List<LanReportedScan>)

@Serializable
data class LanPushResult(val clientScanId: String, val applied: Boolean)

@Serializable
data class LanPushResponse(val results: List<LanPushResult> = emptyList())

/** Short identification of a master in the DNS-SD TXT record (no secrets, no event ids). */
data class LanAdvert(val deviceId: String, val name: String, val eventHashes: List<String>) {
    fun toAttributes(): Map<String, String> = mapOf(
        "v" to LAN_PROTOCOL_VERSION.toString(),
        "id" to deviceId.take(64),
        "n" to name.take(40),
        "ev" to eventHashes.take(MAX_HASHES).joinToString(","),
    )

    /** true when the master serves at least one of [clientEventIds] (compared by hash). */
    fun servesAny(clientEventIds: Collection<String>): Boolean {
        val mine = clientEventIds.map(::eventHash).toSet()
        return eventHashes.any { it in mine }
    }

    companion object {
        const val MAX_HASHES = 20

        fun eventHash(eventId: String): String =
            MessageDigest.getInstance("SHA-256").digest("tix-lan-ev:$eventId".toByteArray(Charsets.UTF_8))
                .copyOf(4).joinToString("") { "%02x".format(it) }

        fun parse(attrs: Map<String, String>): LanAdvert? {
            if (attrs["v"] != LAN_PROTOCOL_VERSION.toString()) return null
            val id = attrs["id"]?.takeIf { it.isNotBlank() } ?: return null
            return LanAdvert(id, attrs["n"].orEmpty(), attrs["ev"].orEmpty().split(',').filter { it.isNotBlank() })
        }
    }
}
