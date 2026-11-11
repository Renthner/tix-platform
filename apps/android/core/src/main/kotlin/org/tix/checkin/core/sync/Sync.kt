package org.tix.checkin.core.sync

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.SCAN_BATCH_MAX
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.ScannerApi
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.scan.JournalEntry
import org.tix.checkin.core.scan.ScanCommand
import org.tix.checkin.core.contract.ScanRequest
import org.tix.checkin.core.contract.ScanSource

// ─── Delta sync ─────────────────────────────────────────────────────────────

interface TicketSyncStore {
    /** Last stored opaque cursor of the event (null = never synced). */
    suspend fun cursor(eventId: String): String?

    /** Applies the page and stores `page.nextCursor` as the new cursor, atomically. */
    suspend fun applyPage(eventId: String, page: SyncPage)
}

object TicketSync {
    const val DEFAULT_PAGE_SIZE = 500

    /**
     * Pulls every page since the stored cursor (`hasMore` loop). Returns the number of ticket rows
     * received. A page that claims more data but does not advance the cursor ends the loop (a
     * server bug must not turn into an endless request storm).
     */
    suspend fun syncEvent(
        api: ScannerApi,
        store: TicketSyncStore,
        eventId: String,
        pageSize: Int = DEFAULT_PAGE_SIZE,
        onProgress: (received: Int) -> Unit = {},
    ): Int {
        var received = 0
        var cursor: String? = store.cursor(eventId)
        while (true) {
            val page = api.sync(eventId, cursor, pageSize)
            store.applyPage(eventId, page)
            received += page.tickets.size
            onProgress(received)
            val advanced = page.nextCursor.isNotEmpty() && page.nextCursor != cursor
            if (advanced) cursor = page.nextCursor
            if (!page.hasMore || !advanced) return received
        }
    }
}

// ─── Upload of the offline journal ──────────────────────────────────────────

interface JournalUploadStore {
    /** Unsent scans (`uploaded = false`), oldest first by scan time. */
    suspend fun pending(limit: Int): List<JournalEntry>

    /** Journal row + ticket update for a server outcome, in one transaction. */
    suspend fun applyOutcome(entry: JournalEntry, outcome: ScanOutcome)

    /**
     * The server refused this single scan as a request: stop retrying it for now. The store remembers the app
     * version code the scan was quarantined under (see [requeueQuarantined]).
     */
    suspend fun quarantine(entry: JournalEntry, error: String)

    /**
     * Makes quarantined scans uploadable again when they were quarantined under another app version than
     * [appVersion] (an update may fix what the server refused). Scans quarantined by this version stay put.
     */
    suspend fun requeueQuarantined(appVersion: Int)
}

/**
 * [deferred] = scans the server refused but that could not be isolated as the culprit (everything in the
 * batch failed): not quarantined, tried again with the next run.
 */
data class UploadReport(val uploaded: Int, val quarantined: Int, val deferred: Int = 0)

/**
 * Uploads unsent scans with `POST /scans/batch`. A rejected batch (413/422 or an undecodable answer) is
 * bisected. A scan is only quarantined when the bisection isolates it as the culprit, i.e. other scans of the
 * same batch went through. When everything fails (a server-side problem, a proxy answering garbage with 2xx)
 * nothing is quarantined: the round ends with [UploadReport.deferred] and the next run tries again. Network
 * errors, 5xx, 429 and 401 propagate to the caller (which backs off or unpairs) and leave the queue untouched.
 * [appVersion] (the app version code, 0 = off) makes quarantined scans retryable after an app update.
 */
class ScanUploader(
    private val api: ScannerApi,
    private val store: JournalUploadStore,
    private val batchSize: Int = 100,
    private val deviceClock: () -> Long = System::currentTimeMillis,
    private val appVersion: Int = 0,
) {
    init {
        require(batchSize in 1..SCAN_BATCH_MAX)
    }

    /** [failed] = isolated single scans the server refused; [abandoned] = scans not tried further (refusal budget spent). */
    private class Sent(val uploaded: Int, val failed: List<Pair<JournalEntry, String>>, val abandoned: Int = 0)

    /** Refused requests since the last success: bounds the bisection when the server refuses everything. */
    private var consecutiveRefusals = 0

    suspend fun uploadAll(): UploadReport {
        consecutiveRefusals = 0
        if (appVersion > 0) store.requeueQuarantined(appVersion)
        var uploaded = 0
        var quarantined = 0
        var deferred = 0
        while (true) {
            val pending = store.pending(batchSize)
            if (pending.isEmpty()) break
            val r = send(pending)
            uploaded += r.uploaded
            if (r.uploaded > 0) {
                // Others got through: the isolated failing ones are the culprits (abandoned ones are not: retried next run).
                for ((entry, error) in r.failed) store.quarantine(entry, error)
                quarantined += r.failed.size
                if (r.abandoned > 0) {
                    deferred = r.abandoned
                    break
                }
            } else {
                deferred = r.failed.size + r.abandoned
                break // nothing got through (or no progress): try again on the next run
            }
        }
        return UploadReport(uploaded, quarantined, deferred)
    }

    private suspend fun send(entries: List<JournalEntry>): Sent {
        val response = try {
            api.scanBatch(entries.map(::toRequest), org.tix.checkin.core.contract.Iso.format(deviceClock())).results
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            if (e.status == 413 || e.status == 422) return bisect(entries, e.message.orEmpty())
            throw e
        } catch (e: SerializationException) {
            return bisect(entries, "undecodable response")
        }

        consecutiveRefusals = 0
        // Match by position, verified by clientScanId; fall back to the id when the order differs.
        val byId = response.associateBy { it.clientScanId }
        var uploaded = 0
        entries.forEachIndexed { index, entry ->
            val outcome = response.getOrNull(index)?.takeIf { it.clientScanId == entry.clientScanId }
                ?: byId[entry.clientScanId]
            if (outcome != null) {
                store.applyOutcome(entry, outcome)
                uploaded++
            }
        }
        return Sent(uploaded, emptyList())
    }

    private suspend fun bisect(entries: List<JournalEntry>, error: String): Sent {
        consecutiveRefusals++
        if (entries.size == 1) return Sent(0, listOf(entries[0] to error))
        // A server that refuses everything (bug, proxy) must not cost 2n requests: give up, the rest is deferred.
        if (consecutiveRefusals >= MAX_CONSECUTIVE_REFUSALS) return Sent(0, emptyList(), abandoned = entries.size)
        val mid = entries.size / 2
        val a = send(entries.subList(0, mid))
        val b = send(entries.subList(mid, entries.size))
        return Sent(a.uploaded + b.uploaded, a.failed + b.failed, a.abandoned + b.abandoned)
    }

    private fun toRequest(e: JournalEntry) = ScanRequest(
        clientScanId = e.clientScanId,
        eventId = e.eventId,
        action = e.action,
        source = e.source,
        payload = if (e.source == ScanSource.CAMERA) e.payload?.take(ScanCommand.PAYLOAD_UPLOAD_MAX) else null,
        ticketId = if (e.source == ScanSource.MANUAL) e.ticketId else null,
        ticketCode = if (e.source == ScanSource.MANUAL && e.ticketId == null) e.ticketCode else null,
        scannedAt = org.tix.checkin.core.contract.Iso.format(e.scannedAtMillis),
        entranceId = e.entranceId,
    )

    companion object {
        /** A batch of 100 isolates one poison scan in about 7 refusals; far more means the server refuses everything. */
        const val MAX_CONSECUTIVE_REFUSALS = 10
    }
}
