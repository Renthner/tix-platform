package org.tix.checkin.ui

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.tix.checkin.AppContainer
import org.tix.checkin.TixApplication
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.AppLatest
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.scan.DecidedBy
import org.tix.checkin.core.scan.JournalEntry
import org.tix.checkin.core.scan.LocalSearch
import org.tix.checkin.core.scan.LocalTicket
import org.tix.checkin.core.scan.ScanVerdict
import org.tix.checkin.core.DownloadUrl
import org.tix.checkin.core.TicketCode
import org.tix.checkin.data.DeviceConfigEntity
import org.tix.checkin.data.EventEntity
import org.tix.checkin.data.toCore
import org.tix.checkin.data.toLocal
import org.tix.checkin.sync.Connection
import org.tix.checkin.sync.PairException
import org.tix.checkin.sync.SyncScheduler
import org.tix.checkin.sync.SyncStatus

data class EventRow(val event: EventEntity, val validTickets: Int, val lastSyncAt: Long?)

/** A verdict on screen; [seq] makes two identical results distinguishable (restarts the auto-dismiss timer). */
data class VerdictUi(val seq: Long, val verdict: ScanVerdict)

/** One row of the manual lookup list (server or local source). */
data class TicketRow(
    val id: String,
    val ticketCode: String,
    val status: TicketStatus,
    val attendeeName: String?,
    val categoryName: String,
    val seatLabel: String,
    val seatFeature: SeatFeature?,
    val checkInState: CheckInState,
    val orderNumber: String? = null,
    val buyerName: String? = null,
    val firstCheckedInAt: String? = null,
)

sealed interface PairUi {
    data object Idle : PairUi
    data object Working : PairUi
    data object Syncing : PairUi
    data class Failed(val message: Int, val detail: String? = null) : PairUi
}

sealed interface UpdateUi {
    data object Unknown : UpdateUi
    data object Checking : UpdateUi
    data object UpToDate : UpdateUi
    data object NoRelease : UpdateUi
    data class Available(val info: AppLatest) : UpdateUi
    data object Failed : UpdateUi
    data object ServerUrlMissing : UpdateUi
}

class LookupResult(val rows: List<TicketRow>, val fromServer: Boolean)

@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModel(private val app: Application, private val c: AppContainer) : ViewModel() {
    val settings = c.settings
    val feedback = c.feedback

    /** null = still loading the database. */
    val config: StateFlow<DeviceConfigEntity?> = c.dao.deviceConfigFlow().stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val paired: StateFlow<Boolean?> = c.dao.deviceConfigFlow().map { it != null }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val events: StateFlow<List<EventRow>> = combine(
        c.dao.eventsFlow(), c.dao.validCountsFlow(), c.dao.syncStatesFlow(),
    ) { events, counts, states ->
        val countById = counts.associate { it.eventId to it.valid }
        val syncById = states.associate { it.eventId to it.lastSyncAt }
        events.map { EventRow(it, countById[it.id] ?: 0, syncById[it.id]) }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** The event chosen by the operator; with exactly one event it is chosen automatically. */
    val selectedEvent: StateFlow<EventRow?> = combine(events, settings.selectedEventId) { rows, id ->
        rows.firstOrNull { it.event.id == id } ?: rows.singleOrNull()
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val validCount: StateFlow<Int> = selectedEvent.flatMapLatest { e ->
        if (e == null) flowOf(0) else c.dao.validCount(e.event.id)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    val checkedInCount: StateFlow<Int> = selectedEvent.flatMapLatest { e ->
        if (e == null) flowOf(0) else c.dao.checkedInCount(e.event.id)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    /** (eventId, entranceId) -> entrance name from the manifest. */
    val entranceNames: StateFlow<Map<Pair<String, String>, String>> = c.dao.entrancesFlow()
        .map { rows -> rows.associate { (it.eventId to it.id) to it.name } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())

    val pendingCount: StateFlow<Int> = c.dao.pendingCountFlow().stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    /** Scans the server refused as requests (quarantined): never uploaded unless an app update fixes them. */
    val quarantinedCount: StateFlow<Int> = c.dao.quarantinedCountFlow().stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    /** Non-null = unpair is waiting for the operator because scans were never uploaded (export, then discard). */
    val unpairBlock: StateFlow<org.tix.checkin.sync.UnpairBlock?> = c.sync.unpairBlock
    val connection: StateFlow<Connection> = c.monitor.state
    val syncStatus: StateFlow<SyncStatus> = c.sync.status
    val journal: StateFlow<List<JournalEntry>> = c.dao.recentJournal().map { rows -> rows.map { it.toCore() } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    // ─── LAN ───
    val lanState: StateFlow<org.tix.checkin.lan.LanUi> = c.lan.ui

    fun setLanMaster(enabled: Boolean) {
        c.lan.retryMaster()
        settings.setLanMaster(enabled)
        if (enabled && c.lan.isAvailable()) {
            org.tix.checkin.lan.LanMasterService.start(app)
        } else {
            org.tix.checkin.lan.LanMasterService.stop(app)
        }
    }

    fun setLanPort(port: Int) {
        settings.setLanPort(port)
        c.lan.retryMaster()
        if (settings.lanMaster.value && c.lan.isAvailable()) {
            // restart the server on the new port
            org.tix.checkin.lan.LanMasterService.stop(app)
            viewModelScope.launch {
                kotlinx.coroutines.delay(400)
                org.tix.checkin.lan.LanMasterService.start(app)
            }
        }
    }

    fun setLanManual(text: String) = settings.setLanManual(text)
    fun isValidLanManual(text: String) = c.lan.isValidManual(text)

    val mode = MutableStateFlow(ScanAction.CHECK_IN)
    private val _verdict = MutableStateFlow<VerdictUi?>(null)
    val verdict: StateFlow<VerdictUi?> = _verdict
    private var verdictSeq = 0L

    private val _pair = MutableStateFlow<PairUi>(PairUi.Idle)
    val pair: StateFlow<PairUi> = _pair

    private val _update = MutableStateFlow<UpdateUi>(UpdateUi.Unknown)
    val update: StateFlow<UpdateUi> = _update

    fun selectEvent(id: String) {
        settings.setSelectedEvent(id)
        mode.value = ScanAction.CHECK_IN
    }

    fun setMode(action: ScanAction) {
        mode.value = action
    }

    // ─── scanning ───

    fun onCode(raw: String) {
        if (unpairBlock.value != null) return // scanning is disabled while an unpair waits for the operator
        val event = selectedEvent.value ?: return
        val action = mode.value
        viewModelScope.launch {
            val v = withContext(Dispatchers.Default) { c.scans.scanCode(raw, action, event.event.id) }
            show(v)
        }
    }

    fun manualScan(ticketId: String, eventId: String, action: ScanAction, onDone: () -> Unit = {}) {
        if (unpairBlock.value != null) return
        viewModelScope.launch {
            val v = withContext(Dispatchers.Default) { c.scans.scanTicket(ticketId, eventId, action) }
            show(v)
            onDone()
        }
    }

    private fun show(v: ScanVerdict) {
        _verdict.value = VerdictUi(++verdictSeq, v)
        c.feedback.play(v.color, settings.sound.value, settings.vibrate.value)
        // An offline decision is journaled: make sure it is uploaded as soon as a network exists.
        if (v.decidedBy != DecidedBy.SERVER && v.notice == null) SyncScheduler.uploadSoon(app)
    }

    fun dismissVerdict(seq: Long) {
        if (_verdict.value?.seq == seq) _verdict.value = null
    }

    // ─── manual lookup ───

    suspend fun search(eventId: String, query: String): LookupResult {
        val q = query.trim()
        if (q.length < 2) return LookupResult(emptyList(), false)
        if (c.monitor.isUsable()) {
            try {
                val r = withTimeout(4_000) { c.sync.api.lookup(eventId, q, 30) }
                return LookupResult(
                    r.tickets.map {
                        TicketRow(
                            it.id, it.ticketCode, it.status, it.attendeeName, it.categoryName,
                            org.tix.checkin.core.scan.seatText(it.sectionLabel, it.rowLabel, it.seatLabel),
                            it.seatFeature, it.checkInState, it.orderNumber, it.buyerName, it.firstCheckedInAt,
                        )
                    },
                    fromServer = true,
                )
            } catch (e: ApiException) {
                if (e.isUnauthorized) return localSearch(eventId, q)
            } catch (_: Exception) {
                // fall through to the local search (timeout, network)
            }
        }
        return localSearch(eventId, q)
    }

    private suspend fun localSearch(eventId: String, q: String): LookupResult = withContext(Dispatchers.Default) {
        val tokens = LocalSearch.tokens(q)
        if (tokens.isEmpty()) return@withContext LookupResult(emptyList(), false)
        val first = tokens.maxBy { it.length }
        val candidates = c.dao.searchTickets(eventId, first, TicketCode.normalize(first)).map { it.toLocal() }
        val rows = candidates.filter { LocalSearch.matches(it, tokens) }.take(50).map { it.toRow() }
        LookupResult(rows, false)
    }

    private fun LocalTicket.toRow() = TicketRow(
        id, ticketCode, status, attendeeName, categoryName,
        org.tix.checkin.core.scan.seatText(sectionLabel, rowLabel, seatLabel), seatFeature, checkInState,
        firstCheckedInAt = firstCheckedInAt,
    )

    // ─── pairing / settings ───

    fun pair(serverUrl: String, code: String, deviceName: String) {
        if (_pair.value is PairUi.Working || _pair.value is PairUi.Syncing) return
        _pair.value = PairUi.Working
        viewModelScope.launch {
            try {
                c.sync.pair(serverUrl, code, deviceName)
                SyncScheduler.schedulePeriodic(app)
                _pair.value = PairUi.Syncing
                c.sync.syncOnce() // initial manifest + full sync (progress in syncStatus); the loop retries on errors
                _pair.value = PairUi.Idle
            } catch (e: PairException) {
                _pair.value = when {
                    e.urlRefused -> PairUi.Failed(org.tix.checkin.R.string.pairing_error_url)
                    e.keystore -> PairUi.Failed(org.tix.checkin.R.string.pairing_error_keystore)
                    e.code == "INVALID_PAIRING_CODE" -> PairUi.Failed(org.tix.checkin.R.string.pairing_error_code)
                    e.status == null -> PairUi.Failed(org.tix.checkin.R.string.pairing_error_network, e.message)
                    else -> PairUi.Failed(org.tix.checkin.R.string.pairing_error_server, "${e.status} ${e.code.orEmpty()}")
                }
            }
        }
    }

    fun resetPairError() {
        if (_pair.value is PairUi.Failed) _pair.value = PairUi.Idle
    }

    fun syncNow() {
        viewModelScope.launch { c.sync.syncOnce() }
    }

    fun forceResync() {
        viewModelScope.launch {
            c.sync.forceFullResync()
        }
    }

    /** Unpairs - or, with scans that were never uploaded, opens the blocking export screen first. */
    fun unpair() {
        viewModelScope.launch { c.sync.requestOperatorUnpair() }
    }

    fun cancelUnpair() {
        viewModelScope.launch { c.sync.cancelUnpair() }
    }

    /** From the blocking screen: delete everything including the unsent scans. */
    fun discardAndUnpair() {
        viewModelScope.launch { c.sync.unpair(c.sync.unpairBlock.value?.notice) }
    }

    /** A share intent with the unsent scans as a JSON file (null when the file could not be written). */
    suspend fun exportUnsentIntent(): android.content.Intent? = withContext(Dispatchers.IO) {
        try {
            val json = c.sync.exportUnsentScans()
            val dir = java.io.File(app.cacheDir, "exports").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT).format(java.util.Date())
            val file = java.io.File(dir, "unsent-scans-$stamp.json")
            file.writeText(json)
            val uri = androidx.core.content.FileProvider.getUriForFile(app, app.packageName + ".files", file)
            android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(android.content.Intent.EXTRA_STREAM, uri)
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } catch (_: Exception) {
            null
        }
    }

    fun checkUpdate() {
        _update.value = UpdateUi.Checking
        viewModelScope.launch {
            _update.value = try {
                val latest = withTimeout(10_000) { c.sync.latestApp() }
                when {
                    latest == null -> UpdateUi.NoRelease
                    latest.versionCode > org.tix.checkin.BuildConfig.VERSION_CODE -> UpdateUi.Available(latest)
                    else -> UpdateUi.UpToDate
                }
            } catch (e: ApiException) {
                if (e.isServerUrlMissing) UpdateUi.ServerUrlMissing else UpdateUi.Failed
            } catch (_: Exception) {
                UpdateUi.Failed
            }
        }
    }

    /**
     * `downloadUrl` may be relative when the server has no public URL configured. Null = refused by the server
     * address policy (https, or http in the local network only): the link is not opened.
     */
    fun downloadUrl(info: AppLatest): String? = DownloadUrl.resolve(config.value?.serverUrl.orEmpty(), info.downloadUrl)

    companion object {
        fun factory(app: Application) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                MainViewModel(app, (app as TixApplication).container) as T
        }
    }
}
