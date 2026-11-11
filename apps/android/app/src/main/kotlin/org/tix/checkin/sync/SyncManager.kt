package org.tix.checkin.sync

import android.os.Build
import io.ktor.client.HttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import org.tix.checkin.core.Pairing
import org.tix.checkin.core.ScanExport
import org.tix.checkin.core.ServerUrlPolicy
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.AppLatest
import org.tix.checkin.core.contract.LookupResponse
import org.tix.checkin.core.contract.ManifestResult
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.OffsetClock
import org.tix.checkin.core.contract.PairRequest
import org.tix.checkin.core.contract.ScanBatchResponse
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.ScanRequest
import org.tix.checkin.core.contract.ScannerApi
import org.tix.checkin.core.contract.TokenUnavailableException
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.scan.LockedJournalUploadStore
import org.tix.checkin.core.scan.LockedTicketSyncStore
import org.tix.checkin.core.sync.ScanUploader
import org.tix.checkin.core.sync.TicketSync
import org.tix.checkin.data.AppSettings
import org.tix.checkin.data.ConfigRepository
import org.tix.checkin.data.DeviceConfigEntity
import org.tix.checkin.data.RoomStore
import org.tix.checkin.data.SyncEpochChangedException
import org.tix.checkin.data.TixDatabase
import org.tix.checkin.data.TokenVault
import org.tix.checkin.data.toCore
import org.tix.checkin.net.KtorScannerApi
import org.tix.checkin.net.Session

/** Learns the server clock offset from every `serverTime` the server sends. */
private class ClockLearningApi(private val inner: ScannerApi, private val clock: OffsetClock) : ScannerApi by inner {
    override suspend fun manifest(etag: String?) = inner.manifest(etag).also {
        if (it is ManifestResult.Updated) clock.learn(it.manifest.serverTime)
    }

    override suspend fun sync(eventId: String, cursor: String?, limit: Int): SyncPage =
        inner.sync(eventId, cursor, limit).also { clock.learn(it.serverTime) }

    override suspend fun scanBatch(requests: List<ScanRequest>, sentAt: String): ScanBatchResponse =
        inner.scanBatch(requests, sentAt).also { clock.learn(it.serverTime) }

    override suspend fun scan(request: ScanRequest): ScanOutcome = inner.scan(request)
    override suspend fun lookup(eventId: String, query: String, limit: Int): LookupResponse = inner.lookup(eventId, query, limit)
    override suspend fun latestApp(): AppLatest? = inner.latestApp()
}

sealed interface SyncResult {
    data object Ok : SyncResult
    data object NotPaired : SyncResult
    data object Unpaired : SyncResult
    data class Failed(val retryAfterSeconds: Int? = null) : SyncResult
}

data class SyncStatus(
    val running: Boolean = false,
    val lastSuccessAt: Long = 0,
    val lastError: String? = null,
    /** The device token cannot be decrypted (Keystore): restart the app or pair again. Nothing is wiped. */
    val tokenUnavailable: Boolean = false,
    /** Tickets received so far in the current run (initial sync progress). */
    val progress: Int? = null,
)

/** Why the device went back to the pairing screen. */
object PairingNotice {
    const val REVOKED = "REVOKED"
}

class PairException(
    val code: String?,
    val status: Int?,
    message: String,
    val urlRefused: Boolean = false,
    /** The Android Keystore could not protect the new device token. */
    val keystore: Boolean = false,
) : Exception(message)

/**
 * The server revoked this device (or the operator unpaired it) while scans exist that were never uploaded. The token
 * is gone, so they can never be uploaded: the operator is shown their number and can export them before they are wiped.
 */
data class UnpairBlock(val unsentScans: Int, val notice: String?)

/**
 * State of the automatic upload retries while an operator-initiated unpair waits ([SyncManager.retryUnpairUpload]).
 * [refused]: everything the server would take was uploaded, the rest was refused for good (retrying is pointless).
 */
data class UnpairRetry(
    val running: Boolean = false,
    val lastAttemptAt: Long = 0,
    val lastError: String? = null,
    val refused: Boolean = false,
)

/**
 * Orchestrates everything that talks to the server in the background: manifest refresh, delta
 * sync, upload of the offline journal, pairing and unpairing. One run at a time (mutex), shared by
 * the foreground loop and the WorkManager worker.
 */
class SyncManager(
    private val db: TixDatabase,
    private val store: RoomStore,
    private val config: ConfigRepository,
    private val settings: AppSettings,
    private val monitor: ConnectionMonitor,
    private val clock: OffsetClock,
    client: HttpClient,
    private val appVersion: String,
    private val appVersionCode: Int,
    /** The shared database lock: every write of ticket rows outside the scan authorities takes it. */
    private val dbLock: Mutex,
    private val scope: CoroutineScope,
    private val onUnpaired: () -> Unit,
    private val onUnpairBlocked: () -> Unit = {},
    private val onUnpairCancelled: () -> Unit = {},
) {
    private val dao = db.dao()
    private val rawApi = KtorScannerApi(client, ::session, appVersion)
    val api: ScannerApi = ClockLearningApi(rawApi, clock)
    private val mutex = Mutex()

    // Only the store writes run under dbLock (never the network calls around them).
    private val lockedJournal = LockedJournalUploadStore(store, dbLock)
    private val lockedTickets = LockedTicketSyncStore(store, dbLock)

    private val _unpairBlock = MutableStateFlow<UnpairBlock?>(null)

    /** Non-null = a blocking screen asks the operator what to do with the unsent scans before the wipe. */
    val unpairBlock: StateFlow<UnpairBlock?> = _unpairBlock

    private val _unpairRetry = MutableStateFlow(UnpairRetry())
    val unpairRetry: StateFlow<UnpairRetry> = _unpairRetry

    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status

    init {
        // An unpair that waited for the operator before the process died is still pending.
        scope.launch {
            val cfg = dao.deviceConfig() ?: return@launch
            if (cfg.unpairPending) {
                _unpairBlock.value = UnpairBlock(dao.unsentCount(), cfg.unpairNotice)
                onUnpairBlocked()
            }
        }
        // A scan answered with 401/403 INVALID_TOKEN / DEVICE_REVOKED: unpair right away instead of waiting for the next sync.
        monitor.onUnauthorized = {
            scope.launch {
                mutex.withLock { if (dao.deviceConfig() != null) requestUnpair(PairingNotice.REVOKED) }
            }
        }
    }

    /** @throws TokenUnavailableException when the Keystore cannot decrypt the token (never a reason to unpair). */
    suspend fun session(): Session? {
        val cfg = dao.deviceConfig() ?: return null
        val token = try {
            TokenVault.decrypt(cfg.tokenCipher)
        } catch (e: TokenUnavailableException) {
            if (!_status.value.tokenUnavailable) _status.value = _status.value.copy(tokenUnavailable = true)
            throw e
        }
        if (_status.value.tokenUnavailable) _status.value = _status.value.copy(tokenUnavailable = false)
        return Session(cfg.serverUrl, token)
    }

    // ─── pairing ───

    suspend fun pair(serverUrl: String, code: String, deviceName: String) {
        val base = serverUrl.trim().trimEnd('/')
        if (!ServerUrlPolicy.isAllowed(base)) throw PairException(null, null, "server url refused", urlRefused = true)
        val response = try {
            rawApi.pair(
                base,
                PairRequest(
                    code = Pairing.normalizeCode(code),
                    deviceName = deviceName.trim(),
                    platform = "android",
                    appVersion = appVersion,
                    deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}".take(80),
                ),
            )
        } catch (e: ApiException) {
            throw PairException(e.code, e.status, e.message.orEmpty())
        } catch (e: NetworkException) {
            throw PairException(null, null, e.message.orEmpty())
        }
        clock.learn(response.serverTime)
        val cipher = try {
            TokenVault.encrypt(response.token)
        } catch (e: TokenUnavailableException) {
            throw PairException(null, null, e.message.orEmpty(), keystore = true)
        }
        dao.putDeviceConfig(
            DeviceConfigEntity(
                serverUrl = base, deviceId = response.deviceId, deviceName = response.deviceName,
                tokenCipher = cipher, clockOffsetMs = clock.offsetMillis,
            ),
        )
        settings.setPairingNotice(null)
        config.reload()
    }

    /**
     * The server revoked this device, or the operator asked to unpair. Wipes at once - unless scans exist that
     * were never uploaded: then nothing is deleted and [unpairBlock] asks the operator (export, then discard).
     */
    suspend fun requestUnpair(notice: String?) {
        val unsent = dao.unsentCount()
        if (unsent > 0) {
            dao.setUnpairBlock(true, notice) // persisted: restored on the next app start
            _unpairBlock.value = UnpairBlock(unsent, notice)
            onUnpairBlocked()
        } else {
            unpair(notice)
        }
    }

    /**
     * The operator asked to unpair: first try to upload what is unsent; the block screen only appears when scans
     * remain afterwards (offline, upload refused, token dead).
     */
    suspend fun requestOperatorUnpair() {
        syncOnce()
        if (_unpairBlock.value != null || dao.deviceConfig() == null) return // blocked by a revocation meanwhile / already wiped
        requestUnpair(null)
    }

    /**
     * One upload attempt while the operator-initiated unpair is blocked (the token is still valid): when nothing is
     * left afterwards the unpair continues on its own. After a revocation the token is dead - nothing to retry there.
     * A 401 turns the block into a revocation block. Failures only update [unpairRetry].
     */
    suspend fun retryUnpairUpload() = mutex.withLock {
        val block = _unpairBlock.value ?: return@withLock
        if (block.notice != null || dao.deviceConfig() == null) return@withLock
        _unpairRetry.value = _unpairRetry.value.copy(running = true, lastError = null)
        try {
            val report = ScanUploader(api, lockedJournal, deviceClock = clock::nowMillis, appVersion = appVersionCode).uploadAll()
            monitor.onSuccess()
            val unsent = dao.unsentCount()
            if (unsent == 0) {
                unpair(null)
                return@withLock
            }
            _unpairBlock.value = block.copy(unsentScans = unsent)
            _unpairRetry.value = UnpairRetry(lastAttemptAt = System.currentTimeMillis(), refused = report.deferred == 0)
        } catch (e: CancellationException) {
            _unpairRetry.value = _unpairRetry.value.copy(running = false)
            throw e
        } catch (e: ApiException) {
            if (e.isUnauthorized) {
                dao.setUnpairBlock(true, PairingNotice.REVOKED)
                _unpairBlock.value = UnpairBlock(dao.unsentCount(), PairingNotice.REVOKED)
                _unpairRetry.value = UnpairRetry()
            } else {
                monitor.onFailure(e)
                _unpairRetry.value = UnpairRetry(lastAttemptAt = System.currentTimeMillis(), lastError = e.message ?: e::class.simpleName)
            }
        } catch (e: Exception) {
            monitor.onFailure(e)
            _unpairRetry.value = UnpairRetry(lastAttemptAt = System.currentTimeMillis(), lastError = e.message ?: e::class.simpleName)
        }
    }

    /** The operator changed their mind (only for an operator-initiated unpair, not after a revocation). */
    suspend fun cancelUnpair() {
        if (_unpairBlock.value?.notice != null) return
        _unpairRetry.value = UnpairRetry()
        dao.setUnpairBlock(false, null)
        _unpairBlock.value = null
        onUnpairCancelled()
    }

    /** The unsent scans (and quarantined ones) as a JSON file text, see [ScanExport]. */
    suspend fun exportUnsentScans(): String {
        val rows = dao.unsentJournal().map { it.toCore() }
        return ScanExport.toJson(rows, dao.deviceConfig()?.deviceName.orEmpty(), clock.nowMillis())
    }

    /** Wipes token, tickets, journal and settings tied to this server. Callers go through [requestUnpair]. */
    suspend fun unpair(notice: String?) {
        _unpairBlock.value = null
        _unpairRetry.value = UnpairRetry()
        TokenVault.deleteKey()
        dbLock.withLock { config.wipeAll() }
        store.ensureLanState()
        settings.setSelectedEvent(null)
        settings.clearAppUpdate()
        settings.setPairingNotice(notice)
        _status.value = SyncStatus()
        onUnpaired()
    }

    // ─── sync ───

    /** Upload the journal, refresh the manifest, pull deltas. Safe to call from anywhere. */
    suspend fun syncOnce(): SyncResult = mutex.withLock {
        if (dao.deviceConfig() == null) return SyncResult.NotPaired
        if (_unpairBlock.value != null) return SyncResult.Unpaired // the token is dead: wait for the operator
        _status.value = _status.value.copy(running = true, progress = null)
        try {
            run()
            monitor.onSuccess()
            _status.value = _status.value.copy(running = false, lastSuccessAt = System.currentTimeMillis(), lastError = null, progress = null)
            SyncResult.Ok
        } catch (e: CancellationException) {
            _status.value = _status.value.copy(running = false)
            throw e
        } catch (e: ApiException) {
            if (e.isUnauthorized) {
                requestUnpair(PairingNotice.REVOKED)
                return SyncResult.Unpaired
            }
            monitor.onFailure(e)
            fail(e)
            SyncResult.Failed(e.retryAfterSeconds)
        } catch (e: Exception) {
            monitor.onFailure(e)
            fail(e)
            SyncResult.Failed()
        }
    }

    private fun fail(e: Exception) {
        _status.value = _status.value.copy(running = false, lastError = e.message ?: e::class.simpleName, progress = null)
    }

    private suspend fun run() {
        // 1. Offline journal first: the server must know our check-ins before we read its state.
        val firstPass = ScanUploader(api, lockedJournal, deviceClock = clock::nowMillis, appVersion = appVersionCode).uploadAll()

        // 2. Manifest (ETag).
        val cfg = dao.deviceConfig() ?: return
        // Without ETag until the update settings of the manifest are known (e.g. right after an app update).
        when (val m = api.manifest(cfg.manifestEtag.takeIf { settings.appUpdateKnown })) {
            ManifestResult.NotModified -> Unit
            is ManifestResult.Updated -> {
                val epoch = m.manifest.syncEpoch
                if (epoch != null && cfg.syncEpoch != null && epoch != cfg.syncEpoch) dbLock.withLock { store.resetSyncData(epoch) }
                dbLock.withLock { config.applyManifest(m.manifest, clock.offsetMillis) }
                settings.setAppUpdate(m.manifest.settings.appUpdate)
                if (epoch != null) adoptEpochIfUnset(epoch)
            }
        }

        // 3. Delta per event. An epoch change in the middle of a run restarts it once.
        try {
            syncEvents()
        } catch (e: SyncEpochChangedException) {
            dbLock.withLock { store.resetSyncData(e.newEpoch) }
            syncEvents()
        }
        // The server may have decided scans meanwhile (and the 10 s settle window): upload once more.
        // (Not when the server refused the first pass as a whole: that would repeat the refusals every round.)
        if (firstPass.deferred == 0) ScanUploader(api, lockedJournal, deviceClock = clock::nowMillis, appVersion = appVersionCode).uploadAll()
    }

    private suspend fun adoptEpochIfUnset(epoch: String) {
        val c = dao.deviceConfig() ?: return
        if (c.syncEpoch == null) dao.putDeviceConfig(c.copy(syncEpoch = epoch))
    }

    private suspend fun syncEvents() {
        var total = 0
        for (event in dao.events()) {
            try {
                var before = total
                TicketSync.syncEvent(api, lockedTickets, event.id) { received ->
                    total = before + received
                    _status.value = _status.value.copy(progress = total)
                }
                before = total
            } catch (e: ApiException) {
                if (e.isEventNotAssigned) dbLock.withLock { config.dropEventAndReload(event.id) } else throw e
            }
        }
    }

    /** Forget the cursors and tickets (unsent scans stay) and pull everything again. */
    suspend fun forceFullResync(): SyncResult {
        mutex.withLock { dbLock.withLock { store.resetSyncData(null) } }
        return syncOnce()
    }

    /** Foreground loop: sync every `syncIntervalSeconds`, exponential backoff on errors, wake on network. */
    suspend fun runLoop() {
        var failures = 0
        while (true) {
            val interval = (dao.deviceConfig()?.syncIntervalSeconds ?: 30).coerceAtLeast(5)
            // The activity loop and the LAN master service loop may both run: skip a round another loop just did.
            val fresh = System.currentTimeMillis() - _status.value.lastSuccessAt < interval * 500L
            val wait = if (fresh) interval * 1000L else when (val r = syncOnce()) {
                SyncResult.Ok -> { failures = 0; interval * 1000L }
                SyncResult.NotPaired, SyncResult.Unpaired -> 3_000L
                is SyncResult.Failed -> {
                    failures++
                    val backoff = minOf(60_000L, 5_000L shl minOf(failures - 1, 4))
                    maxOf(backoff, (r.retryAfterSeconds ?: 0) * 1000L)
                }
            }
            withTimeoutOrNull(wait) { monitor.wake.first() }
        }
    }

    // ─── misc server calls used by the UI ───

    suspend fun latestApp(): AppLatest? = api.latestApp()
}
