package org.tix.checkin.core.contract

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json

/**
 * Wire format of the device API (`/api/scanner/v1`, docs/SCANNER.md). This file is the ONE place
 * where the DTOs live; the zod schemas in packages/shared/src/scanner/contract.ts are the source.
 */
const val SCANNER_API_VERSION = 1

/** Maximum number of scans per `/scans/batch` call (SCAN_BATCH_MAX). */
const val SCAN_BATCH_MAX = 200
const val SYNC_PAGE_MAX = 1000

/**
 * Shared JSON configuration. `explicitNulls = false` is essential: the server's schema treats an
 * explicit `null` for `ticketId` / `ticketCode` / `payload` as present ("exactly one of").
 */
val ScannerJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** Enum that maps unknown wire values to [fallback] instead of failing the whole response. */
open class LenientEnumSerializer<T : Enum<T>>(
    serialName: String,
    private val values: Array<T>,
    private val fallback: T,
) : KSerializer<T> {
    override val descriptor = PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): T {
        val text = decoder.decodeString()
        return values.firstOrNull { it.name == text } ?: fallback
    }

    override fun serialize(encoder: Encoder, value: T) = encoder.encodeString(value.name)
}

object ScanResultSerializer :
    LenientEnumSerializer<ScanResult>("ScanResult", ScanResult.entries.toTypedArray(), ScanResult.UNKNOWN)

object ScanWarningSerializer :
    LenientEnumSerializer<ScanWarning>("ScanWarning", ScanWarning.entries.toTypedArray(), ScanWarning.UNKNOWN)

object ScanColorSerializer :
    LenientEnumSerializer<ScanColor>("ScanColor", ScanColor.entries.toTypedArray(), ScanColor.RED)

object TicketStatusSerializer :
    LenientEnumSerializer<TicketStatus>("TicketStatus", TicketStatus.entries.toTypedArray(), TicketStatus.UNKNOWN)

object SeatFeatureSerializer :
    LenientEnumSerializer<SeatFeature>("SeatFeature", SeatFeature.entries.toTypedArray(), SeatFeature.OTHER)

object KeyStatusSerializer :
    LenientEnumSerializer<KeyStatus>("KeyStatus", KeyStatus.entries.toTypedArray(), KeyStatus.REVOKED)

@Serializable
enum class ScanAction { CHECK_IN, CHECK_OUT }

@Serializable
enum class ScanSource { CAMERA, MANUAL }

@Serializable
enum class CheckInState { NONE, CHECKED_IN, CHECKED_OUT }

/** Anything but VALID is a tombstone. A value this app does not know is [UNKNOWN] (= void). */
@Serializable(with = TicketStatusSerializer::class)
enum class TicketStatus { VALID, CANCELLED, REFUNDED, REPLACED, UNKNOWN }

@Serializable(with = SeatFeatureSerializer::class)
enum class SeatFeature { WHEELCHAIR_SPACE, COMPANION_SEAT, OTHER }

@Serializable(with = KeyStatusSerializer::class)
enum class KeyStatus { ACTIVE, RETIRED, REVOKED }

@Serializable(with = ScanColorSerializer::class)
enum class ScanColor { GREEN, YELLOW, RED }

@Serializable(with = ScanWarningSerializer::class)
enum class ScanWarning { DISCOUNT_PROOF_REQUIRED, WRONG_ENTRANCE, SEAT_FEATURE, ADDITIONAL_PAYMENT_OPEN, UNKNOWN }

/** [UNKNOWN] = a result added by a newer server: shown RED, never treated as accepted. */
@Serializable(with = ScanResultSerializer::class)
enum class ScanResult {
    ACCEPTED,
    ACCEPTED_WITH_WARNING,
    REJECTED_ALREADY_CHECKED_IN,
    REJECTED_NOT_CHECKED_IN,
    REJECTED_INVALID_SIGNATURE,
    REJECTED_WRONG_EVENT,
    REJECTED_TICKET_VOID,
    REJECTED_UNKNOWN_TICKET,
    REJECTED_MALFORMED,
    REJECTED_CHECK_OUT_NOT_ALLOWED,
    UNKNOWN,
    ;

    val isAccepted: Boolean get() = this == ACCEPTED || this == ACCEPTED_WITH_WARNING

    val color: ScanColor
        get() = when (this) {
            ACCEPTED -> ScanColor.GREEN
            ACCEPTED_WITH_WARNING -> ScanColor.YELLOW
            else -> ScanColor.RED
        }
}

// ─── Requests ───────────────────────────────────────────────────────────────

@Serializable
data class PairRequest(
    val code: String,
    val deviceName: String,
    val platform: String? = null,
    val appVersion: String? = null,
    val deviceModel: String? = null,
)

/** Exactly one of [payload], [ticketId], [ticketCode] must be set. */
@Serializable
data class ScanRequest(
    val clientScanId: String,
    val eventId: String,
    val action: ScanAction,
    val source: ScanSource,
    val payload: String? = null,
    val ticketId: String? = null,
    val ticketCode: String? = null,
    val scannedAt: String,
    val entranceId: String? = null,
)

@Serializable
data class ScanBatchRequest(val scans: List<ScanRequest>, val sentAt: String? = null)

// ─── Responses ──────────────────────────────────────────────────────────────

@Serializable
data class ApiError(val error: String = "", val message: String = "")

@Serializable
data class PairResponse(
    val apiVersion: Int = SCANNER_API_VERSION,
    val deviceId: String,
    val deviceName: String,
    val token: String,
    val serverTime: String,
)

@Serializable
data class ManifestKey(val keyId: String, val status: KeyStatus, val publicKey: String? = null)

@Serializable
data class ManifestTicketType(
    val id: String,
    val name: String,
    val requiresProof: Boolean = false,
    val scannerWarning: String? = null,
)

@Serializable
data class ManifestCategory(val id: String, val name: String, val color: String = "")

@Serializable
data class ManifestEntrance(val id: String, val name: String, val code: String = "")

@Serializable
data class ManifestSection(val id: String, val name: String, val entranceId: String? = null)

@Serializable
data class ManifestLan(val enabled: Boolean = false, val secret: String? = null)

@Serializable
data class ManifestEvent(
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val startsAt: String,
    val doorsOpenAt: String? = null,
    val endsAt: String? = null,
    val timeZone: String = "UTC",
    val venueName: String = "",
    val entranceId: String? = null,
    val allowCheckOut: Boolean = false,
    val keys: List<ManifestKey> = emptyList(),
    val ticketTypes: List<ManifestTicketType> = emptyList(),
    val categories: List<ManifestCategory> = emptyList(),
    val entrances: List<ManifestEntrance> = emptyList(),
    val sections: List<ManifestSection> = emptyList(),
    val lan: ManifestLan = ManifestLan(),
)

/** Screen colours (`#RRGGBB` or `#RRGGBBAA`; invalid values fall back to the default per key). */
@Serializable
data class ManifestResultColors(
    val accepted: String = "#16A34A",
    val rejected: String = "#DC2626",
    val discountProof: String = "#FACC15",
    val seatFeature: String = "#14B8A6",
    val wrongEntrance: String = "#2563EB",
    val additionalPaymentOpen: String = "#F97316",
)

/** Default warning priority: the first warning present decides the screen colour. */
val DEFAULT_WARNING_PRIORITY: List<ScanWarning> = listOf(
    ScanWarning.DISCOUNT_PROOF_REQUIRED,
    ScanWarning.WRONG_ENTRANCE,
    ScanWarning.ADDITIONAL_PAYMENT_OPEN,
    ScanWarning.SEAT_FEATURE,
)

@Serializable
data class ManifestSettings(
    val offlineModeAllowed: Boolean = true,
    val lanSyncEnabled: Boolean = false,
    val syncIntervalSeconds: Int = 30,
    /** Optional/additive: absent on an older server. */
    val resultColors: ManifestResultColors = ManifestResultColors(),
    val warningPriority: List<ScanWarning> = DEFAULT_WARNING_PRIORITY,
    /** Additive: absent on an older server = updates come from the paired server (`/app/latest`). */
    val appUpdate: ManifestAppUpdate? = null,
)

/** Raw wire values; interpreted by [org.tix.checkin.core.UpdateSource] / [org.tix.checkin.core.UpdateChannel]. */
@Serializable
data class ManifestAppUpdate(
    val source: String = "SERVER",
    val githubRepository: String = "",
    val defaultChannel: String = "stable",
    val allowChannelOverride: Boolean = true,
)

@Serializable
data class ManifestDevice(val id: String, val name: String)

@Serializable
data class Manifest(
    val apiVersion: Int = SCANNER_API_VERSION,
    val serverTime: String,
    val etag: String,
    val device: ManifestDevice,
    val settings: ManifestSettings = ManifestSettings(),
    val events: List<ManifestEvent> = emptyList(),
    /** Changes when the server's ticket numbering restarts (restore): wipe tickets + cursors, resync. */
    val syncEpoch: String? = null,
    /** Version of the server software; the app is kept on exactly this version (absent on older servers). */
    val serverVersion: String? = null,
)

@Serializable
data class SyncTicket(
    val id: String,
    val ticketCode: String,
    val status: TicketStatus,
    val eventId: String,
    val keyId: String = "",
    val sectionId: String = "",
    val sectionLabel: String = "",
    val rowLabel: String? = null,
    val seatLabel: String? = null,
    val seatFeature: SeatFeature? = null,
    val categoryId: String = "",
    val categoryName: String = "",
    val ticketTypeId: String = "",
    val attendeeName: String? = null,
    val checkInState: CheckInState = CheckInState.NONE,
    val firstCheckedInAt: String? = null,
    val firstCheckedInDeviceName: String? = null,
    val checkInCount: Int = 0,
    val lastScanAt: String? = null,
    val additionalPaymentOpen: Boolean = false,
    val syncVersion: Long,
)

@Serializable
data class SyncPage(
    val tickets: List<SyncTicket> = emptyList(),
    /** OPAQUE cursor: store it as text, send it back as `cursor`, never interpret it. */
    val nextCursor: String = "",
    val hasMore: Boolean = false,
    val serverTime: String? = null,
    val syncEpoch: String? = null,
)

@Serializable
data class ScanTicketDisplay(
    val id: String,
    val ticketCode: String = "",
    val status: TicketStatus = TicketStatus.VALID,
    val attendeeName: String? = null,
    val categoryName: String = "",
    val ticketTypeName: String = "",
    val sectionLabel: String = "",
    val rowLabel: String? = null,
    val seatLabel: String? = null,
    val seatFeature: SeatFeature? = null,
    val checkInState: CheckInState = CheckInState.NONE,
)

@Serializable
data class FirstScan(val at: String, val deviceName: String? = null)

@Serializable
data class ScanOutcome(
    val clientScanId: String,
    val result: ScanResult,
    val color: ScanColor = result.color,
    val warnings: List<ScanWarning> = emptyList(),
    val warningTexts: Map<String, String> = emptyMap(),
    val duplicate: Boolean = false,
    val recorded: Boolean = true,
    val ticket: ScanTicketDisplay? = null,
    val firstScan: FirstScan? = null,
)

@Serializable
data class ScanBatchResponse(val results: List<ScanOutcome> = emptyList(), val serverTime: String? = null)

@Serializable
data class LookupTicket(
    val id: String,
    val ticketCode: String = "",
    val status: TicketStatus = TicketStatus.VALID,
    val attendeeName: String? = null,
    val categoryName: String = "",
    val ticketTypeName: String = "",
    val sectionLabel: String = "",
    val rowLabel: String? = null,
    val seatLabel: String? = null,
    val seatFeature: SeatFeature? = null,
    val checkInState: CheckInState = CheckInState.NONE,
    val orderNumber: String = "",
    val buyerName: String = "",
    val firstCheckedInAt: String? = null,
)

@Serializable
data class LookupResponse(val tickets: List<LookupTicket> = emptyList())

@Serializable
data class AppLatest(
    val versionName: String,
    val versionCode: Int,
    val sha256: String = "",
    val sizeBytes: Long = 0,
    val notes: String? = null,
    val downloadUrl: String,
    val downloadUrlTtlSeconds: Int = 0,
    /** Set by the app for updates found on GitHub (never read from the server answer). */
    @kotlinx.serialization.Transient val viaGithub: Boolean = false,
)
