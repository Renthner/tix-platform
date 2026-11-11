package org.tix.checkin.core.lan

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.scan.ConfigSnapshot
import org.tix.checkin.core.scan.DecidedBy
import org.tix.checkin.core.scan.JournalEntry
import org.tix.checkin.core.scan.LocalTicket
import org.tix.checkin.core.scan.Merge
import org.tix.checkin.core.scan.ScanAuthority
import org.tix.checkin.core.scan.ScanCommand
import org.tix.checkin.core.scan.ScanStore
import org.tix.checkin.core.scan.ScanVerdict
import org.tix.checkin.core.scan.seatText

/** The LAN master cannot answer this scan: the caller falls back to a local decision. */
class LanUnavailableException(message: String) : Exception(message)

/** What the user sees about the LAN. */
enum class LanHealth {
    /** LAN sync not available (no LAN secret from the server). */
    OFF,

    /** A master was found and answers. */
    CONNECTED,

    /** Looking for a master / none answers. */
    NO_MASTER,

    /** A master answers but holds another LAN secret: sync with the server to fetch the current one. */
    KEY_OUTDATED,

    /** A master answers but its clock differs from ours by more than the clock window. */
    CLOCK_SKEW,
}

/**
 * Which master this client currently talks to, and for how long a failed master / event is skipped so a
 * dead master never costs the scan queue more than one short timeout.
 */
class LanMasterLink(private val now: () -> Long = System::currentTimeMillis) {
    @Volatile
    var master: LanEndpoint? = null
        private set

    /** Device id of the last master that answered a valid hello (kept while [master] is null): preferred on reconnect. */
    @Volatile
    var lastMasterId: String? = null
        private set

    @Volatile
    private var unreachableUntil = 0L

    @Volatile
    var keyOutdated = false
        private set

    @Volatile
    var clockSkew = false
        private set

    private val blockedEvents = HashMap<String, Long>()

    fun setMaster(endpoint: LanEndpoint?) {
        master = endpoint
        unreachableUntil = 0
        endpoint?.deviceId?.let { lastMasterId = it }
        if (endpoint == null) {
            keyOutdated = false
            clockSkew = false
        }
    }

    /** The master for [eventId], or null when none, temporarily unreachable or refusing this event. */
    @Synchronized
    fun usable(eventId: String): LanEndpoint? {
        val m = master ?: return null
        val t = now()
        if (t < unreachableUntil) return null
        val blocked = blockedEvents[eventId]
        if (blocked != null && t < blocked) return null
        return m
    }

    @Synchronized
    fun onSuccess() {
        unreachableUntil = 0
        keyOutdated = false
        clockSkew = false
    }

    @Synchronized
    fun onNetworkFailure() {
        unreachableUntil = now() + UNREACHABLE_MILLIS
    }

    /** The master refused this event's key (or our clock): skip LAN for this event only. */
    @Synchronized
    fun onEventRejected(eventId: String, keyMismatch: Boolean, clockSkew: Boolean = false) {
        blockedEvents[eventId] = now() + EVENT_BLOCK_MILLIS
        if (keyMismatch) keyOutdated = true
        if (clockSkew) this.clockSkew = true
    }

    @Synchronized
    fun clearEventBlocks() = blockedEvents.clear()

    val isUnreachable: Boolean get() = now() < unreachableUntil

    companion object {
        const val UNREACHABLE_MILLIS = 5_000L
        const val EVENT_BLOCK_MILLIS = 15_000L
    }
}

/** Chooses one master among several valid ones, deterministically (the same on every client). */
object LanMasterPicker {
    /** The last master that worked if it is still valid, otherwise the one with the lowest device id. */
    fun <T> choose(valid: List<Pair<T, LanHello>>, lastMasterId: String?): Pair<T, LanHello>? {
        if (valid.isEmpty()) return null
        lastMasterId?.let { last -> valid.firstOrNull { it.second.deviceId == last }?.let { return it } }
        return valid.minWithOrNull(compareBy { it.second.deviceId })
    }

    /** More than one distinct master advertises one of [myEventIds]: a client sees the venue split between two masters. */
    fun duplicates(adverts: Collection<LanAdvert>, myEventIds: Collection<String>): Boolean =
        adverts.filter { it.servesAny(myEventIds) }.map { it.deviceId }.distinct().size > 1

    /** Another master than [selfDeviceId] serves one of [myEventIds] (by advert hash): two masters split the LAN. */
    fun conflicting(selfDeviceId: String, adverts: Collection<LanAdvert>, myEventIds: Collection<String>): List<LanAdvert> =
        adverts.filter { it.deviceId != selfDeviceId && it.servesAny(myEventIds) }
}

/**
 * Tracks what is currently advertised via DNS-SD so the advert is re-registered when the served LAN events or
 * the device name change (a stale TXT record sends clients to the wrong master or hides this one).
 */
class LanAdvertTracker {
    private var registered: LanAdvert? = null

    /** true = the advert differs from what is registered (or nothing is): unregister, then register again. */
    @Synchronized
    fun needsRegister(current: LanAdvert): Boolean = registered != current

    @Synchronized
    fun markRegistered(advert: LanAdvert) {
        registered = advert
    }

    @Synchronized
    fun clear() {
        registered = null
    }
}

/**
 * Client side authority: asks the master and mirrors its decision into the local state and the local
 * journal (this device uploads the scan itself later, under its own device id and `clientScanId`).
 */
class LanMasterScanAuthority(
    private val client: LanClient,
    private val link: LanMasterLink,
    private val config: () -> ConfigSnapshot,
    private val store: ScanStore,
    private val lock: Mutex,
    private val timeoutMillis: Long = 800,
) : ScanAuthority {
    override suspend fun scan(command: ScanCommand): ScanVerdict {
        val cfg = config()
        val event = cfg.events[command.eventId] ?: throw LanUnavailableException("event not assigned")
        if (!cfg.offlineModeAllowed) throw LanUnavailableException("offline decisions are not allowed")
        if (event.lanSecret == null) throw LanUnavailableException("LAN disabled for the event")
        // The master does not know this device's check-out permission: refuse here, the local decision explains it.
        if (command.action == ScanAction.CHECK_OUT && !event.allowCheckOut) throw LanUnavailableException("check-out not allowed")
        val master = link.usable(command.eventId) ?: throw LanUnavailableException("no master")

        val response = try {
            client.scan(master, command.eventId, LanScanRequest(command.toRequest(), cfg.deviceName), timeoutMillis)
        } catch (e: LanNetworkException) {
            link.onNetworkFailure()
            throw e
        } catch (e: LanUnauthorizedException) {
            link.onEventRejected(command.eventId, keyMismatch = e is LanKeyMismatchException, clockSkew = e is LanClockException)
            throw e
        }
        link.onSuccess()
        val result = response.result
        if (response.notice != null || result == null) throw LanUnavailableException("master made no decision: ${response.notice}")

        return lock.withLock {
            val ticketId = response.state?.ticketId ?: response.ticket?.id ?: command.ticketId
            val existing = ticketId?.let { store.ticket(it) }
            val updated = response.state?.let { Merge.adoptLanState(existing, it, markLocalDirty = result.isAccepted) }
            val shown = response.ticket
            store.commit(
                JournalEntry(
                    clientScanId = command.clientScanId, eventId = command.eventId, ticketId = ticketId,
                    ticketCode = command.ticketCode, payload = command.payload?.take(ScanCommand.PAYLOAD_UPLOAD_MAX),
                    action = command.action, source = command.source, result = result, warnings = response.warnings,
                    warningTexts = response.warningTexts, scannedAtMillis = command.scannedAtMillis,
                    entranceId = command.entranceId, decidedBy = DecidedBy.LAN, uploaded = false,
                    attendeeName = shown?.attendeeName,
                    seatLabel = shown?.let { seatText(it.sectionLabel, it.rowLabel, it.seatLabel) },
                    categoryName = shown?.categoryName?.takeIf { it.isNotBlank() },
                ),
                updated,
            )
            ScanVerdict(
                clientScanId = command.clientScanId, action = command.action, result = result, color = result.color,
                warnings = response.warnings, warningTexts = response.warningTexts, ticket = shown,
                firstScan = response.firstScan, decidedBy = DecidedBy.LAN, provisional = response.provisional,
            )
        }
    }
}

/** Client database access of the LAN sync loop. */
interface LanClientStore {
    suspend fun cursor(masterId: String, eventId: String): Long
    suspend fun setCursor(masterId: String, eventId: String, cursor: Long)

    /** Counter generation of the master the [cursor] belongs to (null = unknown / never contacted). */
    suspend fun epoch(masterId: String, eventId: String): String?
    suspend fun setEpoch(masterId: String, eventId: String, epoch: String)

    /** Merges the master's ticket states into the local rows with [Merge.adoptLanState], in one transaction. */
    suspend fun applyStates(states: List<LanTicketState>)

    /**
     * Offline (LOCAL) decisions of [eventId] this master has not acknowledged yet, oldest first. The watermark is
     * kept per (master, event) and counts local journal rows ([JournalEntry.rowId]), not scan times: a new master
     * gets everything, and a clock correction can never hide a scan.
     */
    suspend fun unreportedLocalScans(masterId: String, eventId: String, limit: Int): List<JournalEntry>
    suspend fun markReported(masterId: String, eventId: String, entries: List<JournalEntry>)
}

/**
 * One round of the client loop: find/keep a master, pull its changes (only while the server is not
 * usable), report the scans this device decided alone. Pure coordination: sockets live in [LanWire].
 */
class LanClientManager(
    private val client: LanClient,
    private val link: LanMasterLink,
    private val config: () -> ConfigSnapshot,
    private val candidates: () -> List<LanEndpoint>,
    private val store: LanClientStore,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Volatile
    var health: LanHealth = LanHealth.NO_MASTER
        private set

    @Volatile
    var lastContactMillis: Long = 0
        private set

    @Volatile
    var masterName: String? = null
        private set

    /** More than one valid master answered the last SEARCH (not cleared while a master is kept; the UI uses the live DNS-SD list). */
    @Volatile
    var duplicateMasters: Boolean = false
        private set

    private fun lanEvents(): List<String> = config().events.filterValues { it.lanSecret != null }.keys.toList()

    suspend fun tick(serverUsable: Boolean) {
        val events = lanEvents()
        if (events.isEmpty()) {
            link.setMaster(null)
            health = LanHealth.OFF
            masterName = null
            duplicateMasters = false
            return
        }
        if (!ensureMaster(events)) return
        val master = link.master ?: return
        val masterId = master.deviceId ?: return
        for (eventId in events) {
            try {
                if (!serverUsable) pull(master, masterId, eventId)
                push(master, masterId, eventId)
            } catch (e: LanNetworkException) {
                link.onNetworkFailure(); health = LanHealth.NO_MASTER; return
            } catch (e: LanUnauthorizedException) {
                link.onEventRejected(eventId, e is LanKeyMismatchException, e is LanClockException)
                if (e is LanKeyMismatchException) health = LanHealth.KEY_OUTDATED
                if (e is LanClockException) health = LanHealth.CLOCK_SKEW
            } catch (e: CancellationException) {
                throw e
            } catch (_: LanException) {
                // bad answer: try again next round
            }
        }
    }

    private sealed interface Probe {
        class Valid(val endpoint: LanEndpoint, val hello: LanHello) : Probe
        data object KeyMismatch : Probe
        data object ClockSkew : Probe
        data object Down : Probe
    }

    /**
     * Pings the current master (hello, sticky: no flapping between two masters) or looks for one: every
     * candidate is probed in parallel with a short timeout; among the valid answers the last successful master
     * wins, otherwise the lowest device id (the same choice on every client).
     */
    private suspend fun ensureMaster(events: List<String>): Boolean {
        link.master?.let { m ->
            val p = probe(m, events, PING_MILLIS)
            if (p is Probe.Valid) {
                link.onSuccess()
                lastContactMillis = now()
                health = LanHealth.CONNECTED
                masterName = m.name
                return true
            }
            link.setMaster(null)
            if (p is Probe.ClockSkew) health = LanHealth.CLOCK_SKEW
        }
        val found = candidates().distinctBy { it.host to it.port }.take(MAX_CANDIDATES)
        val probes = coroutineScope { found.map { c -> async { probe(c, events, PROBE_MILLIS) } }.awaitAll() }
        val valid = probes.filterIsInstance<Probe.Valid>().map { it.endpoint to it.hello }
        duplicateMasters = valid.map { it.second.deviceId }.distinct().size > 1
        val chosen = LanMasterPicker.choose(valid, link.lastMasterId)
        if (chosen != null) {
            val (endpoint, hello) = chosen
            link.setMaster(endpoint.copy(deviceId = hello.deviceId, name = hello.deviceName))
            link.onSuccess()
            link.clearEventBlocks()
            lastContactMillis = now()
            masterName = hello.deviceName
            health = LanHealth.CONNECTED
            return true
        }
        health = when {
            probes.any { it is Probe.KeyMismatch } -> LanHealth.KEY_OUTDATED
            probes.any { it is Probe.ClockSkew } -> LanHealth.CLOCK_SKEW
            else -> LanHealth.NO_MASTER
        }
        masterName = null
        return false
    }

    /** Tries every LAN event until one is accepted (a master may serve only some of ours). */
    private suspend fun probe(endpoint: LanEndpoint, events: List<String>, timeoutMillis: Long): Probe {
        var mismatch = false
        var skew = false
        for (eventId in events) {
            try {
                return Probe.Valid(endpoint, client.hello(endpoint, eventId, config().deviceName, timeoutMillis))
            } catch (e: CancellationException) {
                throw e
            } catch (e: LanKeyMismatchException) {
                mismatch = true
            } catch (e: LanClockException) {
                skew = true
            } catch (e: LanNetworkException) {
                return Probe.Down
            } catch (_: LanException) {
                // this event is not served / the answer is not trustworthy: try the next one
            }
        }
        return when {
            mismatch -> Probe.KeyMismatch
            skew -> Probe.ClockSkew
            else -> Probe.Down
        }
    }

    private suspend fun pull(master: LanEndpoint, masterId: String, eventId: String) {
        var cursor = store.cursor(masterId, eventId)
        while (true) {
            val page = client.sync(master, eventId, LanSyncRequest(eventId, cursor, PAGE))
            lastContactMillis = now()
            if (page.epoch.isNotEmpty()) {
                val known = store.epoch(masterId, eventId)
                if (known != page.epoch) {
                    store.setEpoch(masterId, eventId, page.epoch)
                    if (known != null) { // the master's counter started over (data wiped, paired again): our cursor is void
                        store.setCursor(masterId, eventId, 0)
                        cursor = 0
                        continue
                    }
                }
            }
            if (cursor > page.maxCursor) { // an older master without an epoch was reset: start over
                store.setCursor(masterId, eventId, 0)
                return
            }
            if (page.changes.isNotEmpty()) store.applyStates(page.changes)
            if (page.nextCursor != cursor) {
                cursor = page.nextCursor
                store.setCursor(masterId, eventId, cursor)
            }
            if (!page.hasMore) return
        }
    }

    private suspend fun push(master: LanEndpoint, masterId: String, eventId: String) {
        while (true) {
            val batch = store.unreportedLocalScans(masterId, eventId, PUSH_BATCH)
            if (batch.isEmpty()) return
            val response = client.push(
                master, eventId,
                LanPushRequest(
                    config().deviceName,
                    batch.map { LanReportedScan(it.toScanRequest(), it.result) },
                ),
            )
            lastContactMillis = now()
            if (response.results.size < batch.size) return // partial answer: retry next round
            store.markReported(masterId, eventId, batch)
            if (batch.size < PUSH_BATCH) return
        }
    }

    private fun JournalEntry.toScanRequest() = org.tix.checkin.core.contract.ScanRequest(
        clientScanId = clientScanId, eventId = eventId, action = action, source = source,
        payload = if (source == org.tix.checkin.core.contract.ScanSource.CAMERA) payload else null,
        ticketId = if (source == org.tix.checkin.core.contract.ScanSource.MANUAL) ticketId else null,
        scannedAt = Iso.format(scannedAtMillis), entranceId = entranceId,
    )

    companion object {
        const val PAGE = 200
        const val PUSH_BATCH = 50
        const val MAX_CANDIDATES = 16
        const val PING_MILLIS = 800L
        const val PROBE_MILLIS = 600L
    }
}
