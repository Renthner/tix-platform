package org.tix.checkin.core.contract

import java.time.Instant
import java.time.temporal.ChronoUnit

/** The server answered with an error status (docs/SCANNER.md, "Status codes"). */
class ApiException(
    val status: Int,
    val code: String?,
    message: String,
    val retryAfterSeconds: Int? = null,
) : Exception("HTTP $status ${code ?: ""}: $message") {
    /**
     * 401/403 with the error code `INVALID_TOKEN` or `DEVICE_REVOKED`: the server really revoked this device,
     * the app must unpair. Any other 401/403 (captive portal, proxy, misconfigured gateway) carries no such
     * code and is treated like an outage.
     */
    val isUnauthorized: Boolean get() = (status == 401 || status == 403) && code in REVOKE_CODES

    /** 403 EVENT_NOT_ASSIGNED: the assignment changed in the admin portal. */
    val isEventNotAssigned: Boolean get() = status == 403 && code == "EVENT_NOT_ASSIGNED"

    /**
     * 503 MAINTENANCE (a restore is running): behave like offline. Only this code means maintenance; any other
     * 503 (BUSY under load, a proxy, SERVER_URL_MISSING) is a transient outage.
     */
    val isMaintenance: Boolean get() = status == 503 && code == "MAINTENANCE"

    /** 503 SERVER_URL_MISSING on `/app/latest`: no public server URL is configured (admin task, not an outage). */
    val isServerUrlMissing: Boolean get() = status == 503 && code == SERVER_URL_MISSING

    companion object {
        const val SERVER_URL_MISSING = "SERVER_URL_MISSING"
        const val INVALID_TOKEN = "INVALID_TOKEN"
        const val DEVICE_REVOKED = "DEVICE_REVOKED"
        val REVOKE_CODES: Set<String> = setOf(INVALID_TOKEN, DEVICE_REVOKED)
    }
}

/**
 * The device token cannot be read (Android Keystore failure, key lost). NOT a server answer: never a reason
 * to unpair or wipe - the scan journal stays, the user is told to restart the app or pair again.
 */
class TokenUnavailableException(message: String = "device key unavailable", cause: Throwable? = null) : Exception(message, cause)

/** No usable answer: connection failure, timeout, undecodable response. */
class NetworkException(message: String, cause: Throwable? = null) : Exception(message, cause)

sealed interface ManifestResult {
    data object NotModified : ManifestResult
    data class Updated(val manifest: Manifest) : ManifestResult
}

/** Authenticated device endpoints. Implemented with Ktor in the app, faked in tests. */
interface ScannerApi {
    /** [etag] is the body `etag` of the last manifest (the implementation sends it quoted). */
    suspend fun manifest(etag: String?): ManifestResult
    /** [cursor] null/empty = full sync. */
    suspend fun sync(eventId: String, cursor: String?, limit: Int): SyncPage
    suspend fun scan(request: ScanRequest): ScanOutcome
    /** [sentAt] = device clock at send time (server-side clock-skew correction). */
    suspend fun scanBatch(requests: List<ScanRequest>, sentAt: String): ScanBatchResponse
    suspend fun lookup(eventId: String, query: String, limit: Int): LookupResponse

    /** null = no release published (404 NO_RELEASE). */
    suspend fun latestApp(): AppLatest?
}

/** Server clock helpers. The device clock is corrected by the offset learned from `serverTime`. */
object Iso {
    /** Millis since epoch of an ISO 8601 timestamp with offset or `Z`; null when unparsable. */
    fun parseMillis(text: String?): Long? {
        if (text.isNullOrBlank()) return null
        return try {
            java.time.OffsetDateTime.parse(text).toInstant().toEpochMilli()
        } catch (_: java.time.format.DateTimeParseException) {
            null
        }
    }

    /** Always includes seconds (the server's zod `iso.datetime` insists on a full time). */
    fun format(millis: Long): String = Instant.ofEpochMilli(millis).truncatedTo(ChronoUnit.MILLIS).toString()
}

/** Corrected "now": device clock + learned offset to the server clock. */
fun interface Clock {
    fun nowMillis(): Long
}

class OffsetClock(@Volatile var offsetMillis: Long = 0L) : Clock {
    override fun nowMillis(): Long = System.currentTimeMillis() + offsetMillis

    /** Learns the offset from a `serverTime` value received "now". */
    fun learn(serverTime: String?) {
        Iso.parseMillis(serverTime)?.let { offsetMillis = it - System.currentTimeMillis() }
    }
}
