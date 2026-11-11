package org.tix.checkin.core.lan

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.tix.checkin.core.TicketCode
import org.tix.checkin.core.TicketPayload
import org.tix.checkin.core.TicketVerifyResult
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.ScannerJson
import org.tix.checkin.core.scan.ConfigSnapshot
import org.tix.checkin.core.scan.DecideContext
import org.tix.checkin.core.scan.LocalScanAuthority
import org.tix.checkin.core.scan.LocalTicket
import org.tix.checkin.core.scan.Merge
import org.tix.checkin.core.scan.ScanCommand
import org.tix.checkin.core.scan.ScanStore

/** Master-side database access on top of the scan store. */
interface LanMasterStore : ScanStore {
    /**
     * Writes the ticket row and assigns it the next position of the LAN change feed, atomically. Positions come
     * from a persistent counter that only ever grows (never `MAX(lanSeq) + 1`: deleting rows must not reuse a
     * position a client already passed). The caller holds the database lock.
     */
    suspend fun commitLan(ticket: LocalTicket)

    /** Tickets of [eventId] changed on this device with feed position > [seq], ascending. */
    suspend fun changedSince(eventId: String, seq: Long, limit: Int): List<LocalTicket>

    /** Highest position handed out so far (the persistent counter). */
    suspend fun maxLanSeq(): Long

    /**
     * Identifies the counter's generation. It changes whenever the counter starts over (app data wiped, device
     * paired again); a client that sees another value than before discards its cursor.
     */
    suspend fun lanEpoch(): String
}

/** One authenticated LAN request as logged by the master (device ids only, never ticket data). */
data class LanRequestLog(val atMillis: Long, val deviceId: String, val path: String)

/** Which devices talked to the master recently (status display) and a bounded log of who asked what. */
class LanPeers {
    private val seen = HashMap<String, Long>()
    private val log = ArrayDeque<LanRequestLog>()

    /** The most recent requests (oldest first, at most [LOG_SIZE]): who used the master's secret-protected API. */
    @Synchronized
    fun recentRequests(): List<LanRequestLog> = log.toList()

    @Synchronized
    fun logRequest(deviceId: String, path: String, now: Long) {
        log.addLast(LanRequestLog(now, deviceId, path))
        while (log.size > LOG_SIZE) log.removeFirst()
    }

    companion object {
        const val LOG_SIZE = 200
    }

    @Volatile
    var lastContactMillis: Long = 0
        private set

    @Synchronized
    fun record(deviceId: String, now: Long) {
        seen[deviceId] = now
        lastContactMillis = now
    }

    @Synchronized
    fun activeCount(now: Long, windowMillis: Long = 2 * 60_000L): Int {
        seen.values.removeAll { now - it > 10 * windowMillis }
        return seen.values.count { now - it <= windowMillis }
    }
}

private class Lru<V>(private val capacity: Int) {
    private val map = object : LinkedHashMap<String, V>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?) = size > capacity
    }

    operator fun get(key: String): V? = map[key]
    operator fun set(key: String, value: V) { map[key] = value }
}

/**
 * The master's side of the LAN protocol. While the internet is down the master is the authority of the
 * LAN: it decides with its own ticket table (the same [LocalScanAuthority.decide] rules, using the
 * scanning device's name and entrance), writes only the ticket state (not its own upload journal -
 * each device uploads its own scans) and numbers every change for the pull feed. [lock] is the
 * database lock shared with the master's own scans, so the two can never race.
 */
class LanMasterHandler(
    private val config: () -> ConfigSnapshot,
    private val store: LanMasterStore,
    private val lock: Mutex,
    private val clock: Clock,
    private val peers: LanPeers,
    private val selfDeviceId: () -> String,
) : LanHandler {
    private val local = LocalScanAuthority(config, store, lock)
    private val answers = Lru<ByteArray>(2_000)
    private val pushed = Lru<Boolean>(5_000)

    override suspend fun handle(path: String, eventId: String, deviceId: String, body: ByteArray): ByteArray {
        val seenAt = clock.nowMillis()
        peers.record(deviceId, seenAt)
        peers.logRequest(deviceId, path, seenAt)
        val text = body.toString(Charsets.UTF_8)
        return when (path) {
            LanPaths.HELLO -> {
                ScannerJson.decodeFromString<LanHelloRequest>(text)
                val cfg = config()
                encode(LanHello(deviceId = selfDeviceId(), deviceName = cfg.deviceName, events = cfg.events.filterValues { it.lanSecret != null }.keys.toList()))
            }
            LanPaths.SCAN -> encode(scan(eventId, deviceId, ScannerJson.decodeFromString<LanScanRequest>(text)))
            LanPaths.SCANS -> encode(push(eventId, deviceId, ScannerJson.decodeFromString<LanPushRequest>(text)))
            LanPaths.SYNC -> encode(sync(eventId, ScannerJson.decodeFromString<LanSyncRequest>(text)))
            else -> throw LanNotFoundException(path)
        }
    }

    private inline fun <reified T> encode(v: T): ByteArray = ScannerJson.encodeToString(v).toByteArray(Charsets.UTF_8)

    private fun stateOf(cfg: ConfigSnapshot, t: LocalTicket) = LanTicketState(
        ticketId = t.id, eventId = t.eventId, keyId = t.keyId, status = t.status, checkInState = t.checkInState,
        firstCheckedInAt = t.firstCheckedInAt, firstCheckedInDeviceName = t.firstCheckedInDeviceName,
        checkInCount = t.checkInCount, lastScanAt = t.lastScanAt, seq = t.lanSeq,
        display = t.display(cfg.events[t.eventId]?.ticketTypes?.get(t.ticketTypeId)?.name.orEmpty()),
    )

    private fun timeOf(iso: String): Long {
        val now = clock.nowMillis()
        // A client clock far in the future must not freeze the ticket (stale rule); never later than "now".
        return Iso.parseMillis(iso)?.coerceAtMost(now) ?: now
    }

    private suspend fun scan(eventId: String, deviceId: String, req: LanScanRequest): LanScanResponse {
        val sr = req.scan
        if (sr.eventId != eventId) throw LanBadRequestException("event mismatch")
        val cmd = ScanCommand(
            clientScanId = sr.clientScanId, eventId = sr.eventId, action = sr.action, source = sr.source,
            payload = sr.payload, ticketId = sr.ticketId, ticketCode = sr.ticketCode,
            scannedAtMillis = timeOf(sr.scannedAt), entranceId = sr.entranceId,
        )
        return lock.withLock {
            // A retry of a scan we already decided (the client timed out) gets the same answer.
            val answerKey = "$deviceId/${sr.clientScanId}"
            answers[answerKey]?.let { return@withLock ScannerJson.decodeFromString<LanScanResponse>(it.toString(Charsets.UTF_8)) }
            // The envelope's event is authenticated (its key opened the message): a ticket of any other event is RED.
            val d = local.decide(cmd, DecideContext(req.deviceName, sr.entranceId, checkOutAllowed = true, lan = true), expectedEventId = eventId)
            d.updated?.let { store.commitLan(it) }
            val v = d.verdict
            val cfg = config()
            val response = LanScanResponse(
                clientScanId = sr.clientScanId, result = v.result, notice = v.notice?.name, warnings = v.warnings,
                warningTexts = v.warningTexts, ticket = v.ticket, firstScan = v.firstScan,
                state = d.current?.let { stateOf(cfg, it) }, provisional = v.provisional,
            )
            answers[answerKey] = encode(response)
            response
        }
    }

    private suspend fun push(eventId: String, deviceId: String, req: LanPushRequest): LanPushResponse {
        val cfg = config()
        val event = cfg.events[eventId] ?: throw LanBadRequestException("event not served")
        val batch = req.scans.take(200)
        fun idOf(sr: org.tix.checkin.core.contract.ScanRequest): String? =
            sr.payload?.let { TicketPayload.parse(it)?.ticketId } ?: sr.ticketId
        // Like the server: a batch is applied in scannedAt order (ties: request order), results go back in request order.
        val order = batch.indices.sortedWith(compareBy({ timeOf(batch[it].scan.scannedAt) }, { it }))
        val applied = BooleanArray(batch.size)
        for (index in order) {
            val r = batch[index]
            val sr = r.scan
            applied[index] = lock.withLock {
                val pushKey = "$deviceId/${sr.clientScanId}"
                if (!r.result.isAccepted || sr.eventId != eventId || pushed[pushKey] != null) return@withLock false
                val at = timeOf(sr.scannedAt)
                var ticket: LocalTicket? = null
                var parsed: org.tix.checkin.core.ParsedTicketPayload? = null
                if (sr.source == ScanSource.CAMERA) {
                    val p = sr.payload?.let { TicketPayload.parse(it) } ?: return@withLock false
                    if (p.eventId != eventId) return@withLock false
                    val v = TicketPayload.verify(p, eventId) { _, keyId -> event.keys[keyId] }
                    if (v is TicketVerifyResult.Invalid) return@withLock false
                    parsed = p
                    val row = store.ticket(p.ticketId)
                    if (row != null && row.eventId != eventId) return@withLock false // never replace a row of another event
                    ticket = row
                } else {
                    ticket = when {
                        sr.ticketId != null -> store.ticket(sr.ticketId!!)?.takeIf { it.eventId == eventId }
                        sr.ticketCode != null -> store.ticketByCode(eventId, TicketCode.normalize(sr.ticketCode!!))
                        else -> null
                    }
                }
                if (ticket == null) {
                    if (parsed == null || sr.action != ScanAction.CHECK_IN) return@withLock false
                    store.commitLan(Merge.provisionalFromLan(eventId, parsed.ticketId, parsed.keyId, parsed.seatInfo, at, req.deviceName))
                    pushed[pushKey] = true
                    return@withLock true
                }
                // A check-out of this ticket in the same batch between this scan and the recorded first entry?
                val firstAt = Iso.parseMillis(ticket.firstCheckedInAt)
                val tid = ticket.id
                val exitBetween = sr.action == ScanAction.CHECK_IN && firstAt != null && at < firstAt &&
                    batch.any { o ->
                        o.scan.action == ScanAction.CHECK_OUT && idOf(o.scan) == tid &&
                            timeOf(o.scan.scannedAt).let { it > at && it < firstAt }
                    }
                val updated = Merge.afterReportedScan(ticket, sr.action, at, req.deviceName, exitBetween) ?: return@withLock false
                store.commitLan(updated)
                pushed[pushKey] = true // only after a successful commit: a failed write is retried on the next push
                true
            }
        }
        peers.record(deviceId, clock.nowMillis())
        return LanPushResponse(batch.mapIndexed { i, r -> LanPushResult(r.scan.clientScanId, applied[i]) })
    }

    private suspend fun sync(eventId: String, req: LanSyncRequest): LanSyncResponse {
        if (req.eventId != eventId) throw LanBadRequestException("event mismatch")
        val limit = req.limit.coerceIn(1, 500)
        val cfg = config()
        val rows = store.changedSince(eventId, req.cursor.coerceAtLeast(0), limit + 1)
        val page = rows.take(limit)
        return LanSyncResponse(
            changes = page.map { stateOf(cfg, it) },
            nextCursor = page.lastOrNull()?.lanSeq ?: req.cursor,
            hasMore = rows.size > limit,
            maxCursor = store.maxLanSeq(),
            epoch = store.lanEpoch(),
        )
    }
}
