package org.tix.checkin.lan

import android.app.Application
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import org.tix.checkin.core.ServerUrlPolicy
import org.tix.checkin.core.contract.OffsetClock
import org.tix.checkin.core.lan.LAN_DEFAULT_PORT
import org.tix.checkin.core.lan.LanAdvert
import org.tix.checkin.core.lan.LanAdvertTracker
import org.tix.checkin.core.lan.LanClient
import org.tix.checkin.core.lan.LanClientManager
import org.tix.checkin.core.lan.LanEndpoint
import org.tix.checkin.core.lan.LanHealth
import org.tix.checkin.core.lan.LanHttpClient
import org.tix.checkin.core.lan.LanHttpServer
import org.tix.checkin.core.lan.LanMasterHandler
import org.tix.checkin.core.lan.LanMasterLink
import org.tix.checkin.core.lan.LanMasterPicker
import org.tix.checkin.core.lan.LanMasterScanAuthority
import org.tix.checkin.core.lan.LanPeers
import org.tix.checkin.core.lan.LanRequestProcessor
import org.tix.checkin.core.scan.LockedLanClientStore
import org.tix.checkin.core.scan.ScanAuthority
import org.tix.checkin.core.scan.ScanCommand
import org.tix.checkin.core.scan.ScanVerdict
import org.tix.checkin.data.AppSettings
import org.tix.checkin.data.ConfigRepository
import org.tix.checkin.data.RoomStore
import org.tix.checkin.data.TixDatabase
import org.tix.checkin.sync.Connection
import org.tix.checkin.sync.ConnectionMonitor

enum class LanRole { OFF, MASTER, CLIENT }

/** What the UI shows about the LAN. */
data class LanUi(
    /** The server delivers a LAN secret for at least one event of this device. */
    val available: Boolean = false,
    val role: LanRole = LanRole.OFF,
    val health: LanHealth = LanHealth.OFF,
    val masterName: String? = null,
    val clients: Int = 0,
    val lastContactMillis: Long = 0,
    /** The master server could not bind its port. */
    val serverError: Boolean = false,
    /** Another master serves the same event(s): the venue's scanners would split between two masters. */
    val duplicateMaster: Boolean = false,
)

/**
 * Everything LAN on this device: either the master (embedded server + DNS-SD advertisement, kept alive
 * by [LanMasterService]) or a client (discovery, hello/pull/push loop, the authority in the scan chain).
 * Master and client never run at the same time.
 */
class LanManager(
    private val app: Application,
    private val config: ConfigRepository,
    private val settings: AppSettings,
    private val store: RoomStore,
    db: TixDatabase,
    private val clock: OffsetClock,
    /** Serialises read-modify-write of local ticket rows (local scans, server answers, LAN requests). */
    val dbLock: Mutex,
    private val monitor: ConnectionMonitor,
    private val scope: CoroutineScope,
) {
    val peers = LanPeers()
    val link = LanMasterLink()
    private val nsd = LanNsd(app)
    private val client = LanClient(LanHttpClient(), clock) { config.snapshot }
    private val advertTracker = LanAdvertTracker()

    private val manager = LanClientManager(
        client = client, link = link, config = { config.snapshot }, candidates = ::candidates,
        store = LockedLanClientStore(LanClientDb(db, settings), dbLock),
    )

    private val _ui = MutableStateFlow(LanUi())
    val ui: StateFlow<LanUi> = _ui

    @Volatile
    private var server: LanHttpServer? = null

    @Volatile
    private var masterPort = 0

    @Volatile
    private var serverError = false

    /** The authority the scan chain asks when the server is down; inactive while this device is the master. */
    val clientAuthority: ScanAuthority = object : ScanAuthority {
        private val inner = LanMasterScanAuthority(client, link, { config.snapshot }, store, dbLock)
        override suspend fun scan(command: ScanCommand): ScanVerdict {
            if (settings.lanMaster.value) throw org.tix.checkin.core.lan.LanUnavailableException("this device is the master")
            return inner.scan(command)
        }
    }

    init {
        // Status ticker (cheap): feeds the UI, keeps the DNS-SD advert current and shuts the master down when the
        // server withdrew the LAN secrets. Not before the configuration is loaded: an empty snapshot has no secrets.
        scope.launch {
            while (true) {
                try {
                    if (isConfigLoaded()) {
                        if (settings.lanMaster.value && !isAvailable()) LanMasterService.stop(app)
                        restartBrokenMaster()
                        maintainMasterAdvert()
                    }
                    refresh()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // a failed tick must never end the ticker
                }
                delay(2_000)
            }
        }
    }

    /** Settings changed (toggle, port): allow a new start attempt. */
    fun retryMaster() {
        serverError = false
    }

    fun isConfigLoaded(): Boolean = config.snapshot.deviceId.isNotEmpty()

    fun isAvailable(): Boolean = config.snapshot.events.values.any { it.lanSecret != null }

    /** Waits until the paired configuration is loaded (app start: the service may come up before it). */
    suspend fun awaitConfig(timeoutMillis: Long = 15_000): Boolean {
        var waited = 0L
        while (!isConfigLoaded()) {
            if (waited >= timeoutMillis) return false
            delay(100)
            waited += 100
        }
        return true
    }

    /** Master mode is on and possible but the server is not running: (re)start the service. Foreground only. */
    fun ensureMasterRunning(context: android.content.Context) {
        if (settings.lanMaster.value && isAvailable() && !serverError && server?.isRunning != true) LanMasterService.start(context)
    }

    private fun lanEventIds() = config.snapshot.events.filterValues { it.lanSecret != null }.keys

    private fun masterAdvert(): LanAdvert {
        val cfg = config.snapshot
        return LanAdvert(cfg.deviceId, cfg.deviceName, lanEventIds().map(LanAdvert::eventHash).sorted())
    }

    private fun refresh() {
        val available = isAvailable()
        val now = clock.nowMillis()
        val masterRunning = server?.isRunning == true
        _ui.value = when {
            !available -> LanUi(available = false, serverError = serverError)
            masterRunning -> LanUi(
                available = true, role = LanRole.MASTER, health = LanHealth.CONNECTED,
                clients = peers.activeCount(now), lastContactMillis = peers.lastContactMillis, serverError = serverError,
                duplicateMaster = otherMastersServingMyEvents(),
            )
            else -> LanUi(
                available = true, role = if (settings.lanMaster.value) LanRole.OFF else LanRole.CLIENT,
                health = if (settings.lanMaster.value) LanHealth.NO_MASTER else manager.health,
                masterName = manager.masterName, lastContactMillis = manager.lastContactMillis, serverError = serverError,
                // From the live DNS-SD list, so it clears when the second master is switched off.
                duplicateMaster = !settings.lanMaster.value &&
                    LanMasterPicker.duplicates(nsd.masters.value.map { it.advert }, lanEventIds()),
            )
        }
    }

    /** DNS-SD: another master than this device advertises one of our events. */
    private fun otherMastersServingMyEvents(): Boolean =
        LanMasterPicker.conflicting(config.snapshot.deviceId, nsd.masters.value.map { it.advert }, lanEventIds()).isNotEmpty()

    // ─── master ───

    /**
     * The listener broke (accept failed) while the service is alive: start the server again, also with the app in the
     * background. Only when a server was started before: the first start belongs to the service.
     */
    private fun restartBrokenMaster() {
        val s = server
        if (s != null && !s.isRunning && settings.lanMaster.value && isAvailable() && !serverError) startMaster()
    }

    /** Re-registers the DNS-SD advert when the served LAN events or the device name changed; browses for rival masters. */
    private fun maintainMasterAdvert() {
        val s = server
        if (s == null || !s.isRunning) return
        val advert = masterAdvert()
        if (advertTracker.needsRegister(advert)) {
            nsd.unregister()
            nsd.register(masterPort, advert)
            advertTracker.markRegistered(advert)
        }
        nsd.startDiscovery() // duplicate-master detection; kept running while this device is the master
    }

    /**
     * Called by the foreground service once the configuration is loaded. Returns false when the port is taken or
     * there is nothing to serve. A dead server object (its listener broke) is replaced.
     */
    @Synchronized
    fun startMaster(): Boolean {
        if (server?.isRunning == true) return true
        if (!isConfigLoaded() || !settings.lanMaster.value) return false // master mode off (e.g. unpair pending)
        server?.stop()
        server = null
        nsd.unregister()
        advertTracker.clear()
        val processor = LanRequestProcessor(
            selfDeviceId = { config.snapshot.deviceId },
            secretFor = { config.snapshot.events[it]?.lanSecret },
            clock = clock,
            handler = LanMasterHandler({ config.snapshot }, store, dbLock, clock, peers) { config.snapshot.deviceId },
        )
        // Bound to every interface (a changing WiFi address needs no rebinding): the server drops sources outside
        // the local network, every request must pass the AES-GCM envelope.
        val s = LanHttpServer(processor, settings.lanPort.value)
        return try {
            val port = s.start()
            server = s
            masterPort = port
            serverError = false
            val advert = masterAdvert()
            nsd.register(port, advert)
            advertTracker.markRegistered(advert)
            nsd.startDiscovery()
            refresh()
            true
        } catch (_: java.io.IOException) {
            s.stop()
            serverError = true
            refresh()
            false
        }
    }

    @Synchronized
    fun stopMaster() {
        nsd.unregister()
        advertTracker.clear()
        server?.stop()
        server = null
        // The client loop restarts discovery when this device is a client; as master nobody needs it any more.
        if (settings.lanMaster.value.not()) nsd.stopDiscovery()
        refresh()
    }

    // ─── client ───

    private fun candidates(): List<LanEndpoint> {
        val events = lanEventIds()
        val list = ArrayList<LanEndpoint>()
        LanEndpoint.parseManual(settings.lanManual.value)?.let { list += it }
        nsd.masters.value.filter { it.advert.servesAny(events) }.forEach { list += it.endpoint }
        // Same rule as for the server address: private / link-local / loopback hosts only.
        return list.filter { ServerUrlPolicy.isAllowed(it.policyUrl) }.distinctBy { it.host to it.port }
    }

    fun isValidManual(text: String) = text.isBlank() || LanEndpoint.parseManual(text)?.let {
        ServerUrlPolicy.isAllowed(it.policyUrl)
    } == true

    /** Foreground loop of a client device (runs while the app is visible). */
    suspend fun runClientLoop() {
        try {
            while (true) {
                val master = settings.lanMaster.value
                if (!master && isAvailable()) {
                    nsd.startDiscovery()
                    try {
                        manager.tick(serverUsable = monitor.state.value == Connection.ONLINE && monitor.isUsable())
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // a failed round must never end the loop
                    }
                } else if (!master) {
                    nsd.stopDiscovery()
                }
                // As master, discovery is owned by the master status ticker (duplicate-master detection).
                refresh()
                delay(10_000)
            }
        } finally {
            if (!settings.lanMaster.value) nsd.stopDiscovery()
        }
    }

    /** Unpair: forget the master. */
    fun reset() {
        link.setMaster(null)
        settings.clearLanState()
    }

    companion object {
        const val DEFAULT_PORT = LAN_DEFAULT_PORT
    }
}
