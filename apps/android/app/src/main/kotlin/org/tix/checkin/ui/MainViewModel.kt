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

    /** Source is GitHub but neither the server nor the app names a repository. */
    data object RepositoryMissing : UpdateUi

    /** GitHub refused further requests until [untilMillis] (unauthenticated limit). */
    data class RateLimited(val untilMillis: Long) : UpdateUi
}

/** Why an in-app update stopped (each has its own text in the settings screen). */
enum class UpdateFailure {
    HASH_MISSING, HASH_MISMATCH, NETWORK, HTTP, TOO_LARGE, STORAGE, URL_REFUSED, NOT_A_VALID_UPDATE,
    SIGNATURE, USER_CANCELLED, BLOCKED, INVALID, OTHER,

    /** The downloaded APK is signed with another certificate than the installed app (checked before the installer). */
    SIGNER_MISMATCH,
}

/** State of the in-app update (download + system installer), separate from "is there a newer version". */
sealed interface InstallUi {
    data object Idle : InstallUi

    /** Scans were not uploaded yet: offer "sync first" before installing. */
    data class UnsentScans(val count: Int) : InstallUi

    /** "Install unknown apps" is not allowed for this app yet: guide the operator to the system setting. */
    data object NeedInstallPermission : InstallUi
    data class Downloading(val read: Long, val total: Long) : InstallUi
    data object Syncing : InstallUi

    /** Handed to the system installer; waiting for the operator's confirmation there. */
    data object Installing : InstallUi
    data class Failed(val reason: UpdateFailure, val detail: String? = null) : InstallUi
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

    /** Screen colours + warning priority from the manifest (defaults until the first manifest with them). */
    val resultPalette: StateFlow<org.tix.checkin.core.scan.ResultPalette> = c.dao.deviceConfigFlow()
        .map { org.tix.checkin.core.scan.ResultPalette.fromJson(it?.resultStyleJson) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, org.tix.checkin.core.scan.ResultPalette.DEFAULT)

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
        if (v.notice?.isInfo == true) {
            c.feedback.playInfo(settings.sound.value, settings.vibrate.value)
        } else {
            // One tone/pattern per ScanColor: every warning colour on screen keeps the (yellow) warning tone.
            c.feedback.play(v.color, settings.sound.value, settings.vibrate.value)
        }
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

    /** Retry state of the unsent-scan upload while the unpair block screen is shown. */
    val unpairRetry: StateFlow<org.tix.checkin.sync.UnpairRetry> = c.sync.unpairRetry

    /** Emits when the network came back (the block screen retries at once). */
    val networkWake: kotlinx.coroutines.flow.SharedFlow<Unit> = c.monitor.wake

    fun retryUnpairUpload() {
        viewModelScope.launch { c.sync.retryUnpairUpload() }
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

    /** Settings screen opened: GitHub is asked from the cache (at most hourly), the own server only on demand. */
    fun checkUpdateOnOpen() {
        if (settings.appUpdate.value.source == org.tix.checkin.core.UpdateSource.GITHUB && _update.value !is UpdateUi.Checking) {
            checkUpdate(force = false)
        }
    }

    /** "Check for update" (force: ask GitHub again with a conditional request even when the cache is younger than an hour). */
    fun checkUpdate(force: Boolean = true) {
        _update.value = UpdateUi.Checking
        viewModelScope.launch {
            val source = settings.appUpdate.value
            if (source.source == org.tix.checkin.core.UpdateSource.GITHUB) {
                val repository = settings.effectiveRepository()
                if (repository.isEmpty()) {
                    _update.value = UpdateUi.RepositoryMissing
                    return@launch
                }
                _update.value = try {
                    val latest = withTimeout(40_000) { c.githubUpdates.check(repository, settings.effectiveChannel(), force) }
                    if (latest == null) UpdateUi.UpToDate else UpdateUi.Available(latest)
                } catch (e: org.tix.checkin.update.GithubUpdateException) {
                    if (e.kind == org.tix.checkin.update.GithubUpdateException.Kind.RATE_LIMITED) UpdateUi.RateLimited(e.retryAtMillis) else UpdateUi.Failed
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    UpdateUi.Failed
                }
                return@launch
            }
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
    fun downloadUrl(info: AppLatest): String? =
        if (info.viaGithub) {
            info.downloadUrl.takeIf(org.tix.checkin.core.GithubHosts::isAllowedUrl)
        } else {
            DownloadUrl.resolve(config.value?.serverUrl.orEmpty(), info.downloadUrl)
        }

    /** Operator picks another channel (only offered when the server allows it); the check runs again. */
    fun setUpdateChannel(channel: org.tix.checkin.core.UpdateChannel) {
        settings.setChannelOverride(channel)
        _update.value = UpdateUi.Unknown
        checkUpdate(force = false)
    }

    // ─── in-app update ───

    private val _install = MutableStateFlow<InstallUi>(InstallUi.Idle)
    val install: StateFlow<InstallUi> = _install
    private val downloader = org.tix.checkin.update.ApkDownloader(app.cacheDir, c.githubUserAgent)
    private var updateJob: kotlinx.coroutines.Job? = null
    private var updateInfo: AppLatest? = null
    private var unsentWarned = false

    init {
        viewModelScope.launch {
            org.tix.checkin.update.ApkInstaller.results.collect { r ->
                if (_install.value !is InstallUi.Installing) return@collect
                if (r.status == android.content.pm.PackageInstaller.STATUS_SUCCESS) {
                    _install.value = InstallUi.Idle
                } else {
                    _install.value = InstallUi.Failed(
                        when (org.tix.checkin.core.ApkUpdate.installFailure(r.status)) {
                            org.tix.checkin.core.ApkUpdate.InstallFailure.SIGNATURE -> UpdateFailure.SIGNATURE
                            org.tix.checkin.core.ApkUpdate.InstallFailure.USER_CANCELLED -> UpdateFailure.USER_CANCELLED
                            org.tix.checkin.core.ApkUpdate.InstallFailure.STORAGE -> UpdateFailure.STORAGE
                            org.tix.checkin.core.ApkUpdate.InstallFailure.BLOCKED -> UpdateFailure.BLOCKED
                            org.tix.checkin.core.ApkUpdate.InstallFailure.INVALID -> UpdateFailure.INVALID
                            org.tix.checkin.core.ApkUpdate.InstallFailure.OTHER -> UpdateFailure.OTHER
                        },
                        r.message,
                    )
                }
                downloader.clean()
            }
        }
    }

    /** "Update now": unsent-scan warning, install permission, download + verify, system installer. */
    fun startUpdate(info: AppLatest) {
        if (updateJob?.isActive == true) return
        updateInfo = info
        unsentWarned = false
        proceedUpdate(info)
    }

    private fun proceedUpdate(info: AppLatest) {
        val unsent = pendingCount.value
        if (org.tix.checkin.core.ApkUpdate.gate(unsent, unsentWarned) == org.tix.checkin.core.ApkUpdate.Gate.WARN_UNSENT_SCANS) {
            _install.value = InstallUi.UnsentScans(unsent)
            return
        }
        if (!org.tix.checkin.update.ApkInstaller.canInstall(app)) {
            _install.value = InstallUi.NeedInstallPermission
            return
        }
        val url = downloadUrl(info)
        if (url == null) {
            _install.value = InstallUi.Failed(UpdateFailure.URL_REFUSED)
            return
        }
        _install.value = InstallUi.Downloading(0, info.sizeBytes)
        updateJob = viewModelScope.launch {
            try {
                val file = downloader.download(url, info.sha256, info.sizeBytes, info.viaGithub) { read, total ->
                    _install.value = InstallUi.Downloading(read, total)
                }
                val problem = validateUpdate(file, if (info.viaGithub) info.versionCode else null)
                if (problem != null) {
                    downloader.clean()
                    _install.value = InstallUi.Failed(problem)
                    return@launch
                }
                _install.value = InstallUi.Installing
                withContext(Dispatchers.IO) { org.tix.checkin.update.ApkInstaller.install(app, file) }
            } catch (e: kotlinx.coroutines.CancellationException) {
                downloader.clean()
                _install.value = InstallUi.Idle
                throw e
            } catch (e: org.tix.checkin.update.UpdateException) {
                _install.value = InstallUi.Failed(
                    when (e.kind) {
                        org.tix.checkin.update.UpdateException.Kind.HASH_MISSING -> UpdateFailure.HASH_MISSING
                        org.tix.checkin.update.UpdateException.Kind.HASH_MISMATCH -> UpdateFailure.HASH_MISMATCH
                        org.tix.checkin.update.UpdateException.Kind.NETWORK -> UpdateFailure.NETWORK
                        org.tix.checkin.update.UpdateException.Kind.HTTP -> UpdateFailure.HTTP
                        org.tix.checkin.update.UpdateException.Kind.TOO_LARGE -> UpdateFailure.TOO_LARGE
                        org.tix.checkin.update.UpdateException.Kind.STORAGE -> UpdateFailure.STORAGE
                        org.tix.checkin.update.UpdateException.Kind.URL_REFUSED -> UpdateFailure.URL_REFUSED
                    },
                    e.message,
                )
            } catch (e: Exception) {
                downloader.clean()
                _install.value = InstallUi.Failed(UpdateFailure.OTHER, e.message)
            }
        }
    }

    /**
     * The downloaded file must be an APK of this app with a higher version code and the same signing certificate
     * as the installed app (Android enforces the latter too; checking first gives a clear message). Null = fine.
     */
    private suspend fun validateUpdate(file: java.io.File, expectedVersionCode: Int?): UpdateFailure? = withContext(Dispatchers.IO) {
        val info = app.packageManager.getPackageArchiveInfo(file.absolutePath, 0) ?: return@withContext UpdateFailure.NOT_A_VALID_UPDATE
        val valid = info.packageName == app.packageName &&
            androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(info) > org.tix.checkin.BuildConfig.VERSION_CODE
        // GitHub: the APK must be the version its tag announced (the versionCode is derived from the tag).
        val code = androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(info)
        if (!valid || (expectedVersionCode != null && code != expectedVersionCode.toLong())) return@withContext UpdateFailure.NOT_A_VALID_UPDATE
        val installed = org.tix.checkin.update.ApkSigners.installed(app.packageManager, app.packageName)
        val archive = org.tix.checkin.update.ApkSigners.archive(app.packageManager, file.absolutePath)
        if (org.tix.checkin.core.ApkUpdate.signersMatch(installed, archive)) null else UpdateFailure.SIGNER_MISMATCH
    }

    /** "Upload first": syncs, then continues the update when nothing is pending any more. */
    fun syncThenUpdate() {
        val info = updateInfo ?: return
        _install.value = InstallUi.Syncing
        updateJob = viewModelScope.launch {
            c.sync.syncOnce()
            // Still unsent after the sync (no network?): the operator decides again ("install anyway").
            if (pendingCount.value == 0) proceedUpdate(info) else _install.value = InstallUi.UnsentScans(pendingCount.value)
        }
    }

    fun installAnyway() {
        val info = updateInfo ?: return
        unsentWarned = true
        proceedUpdate(info)
    }

    /** Back from the system "Install unknown apps" page: continue when it is allowed now. */
    fun onResumedFromSettings() {
        val info = updateInfo ?: return
        if (_install.value is InstallUi.NeedInstallPermission && org.tix.checkin.update.ApkInstaller.canInstall(app)) {
            proceedUpdate(info)
        }
    }

    /** Cancels the download (or dismisses a message); partial files are deleted. */
    fun cancelUpdate() {
        updateJob?.cancel()
        updateJob = null
        downloader.clean()
        _install.value = InstallUi.Idle
    }

    companion object {
        fun factory(app: Application) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                MainViewModel(app, (app as TixApplication).container) as T
        }
    }
}
