package org.tix.checkin

import android.app.Application
import androidx.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import org.tix.checkin.lan.LanManager
import org.tix.checkin.lan.LanMasterService
import org.tix.checkin.core.contract.OffsetClock
import org.tix.checkin.core.scan.FallbackScanAuthority
import org.tix.checkin.core.scan.LocalScanAuthority
import org.tix.checkin.core.scan.ScanCoordinator
import org.tix.checkin.core.scan.ServerScanAuthority
import org.tix.checkin.data.AppSettings
import org.tix.checkin.data.ConfigRepository
import org.tix.checkin.data.RoomStore
import org.tix.checkin.data.TixDatabase
import org.tix.checkin.net.TixHttpClient
import org.tix.checkin.sync.ConnectionMonitor
import org.tix.checkin.sync.SyncManager
import org.tix.checkin.sync.SyncScheduler
import org.tix.checkin.ui.Feedback

/** Hand-wired dependency container (one per process; the WorkManager worker uses it too). */
class AppContainer(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val db: TixDatabase = Room.databaseBuilder(app, TixDatabase::class.java, "tix-checkin.db")
        .addMigrations(org.tix.checkin.data.MIGRATION_1_2) // never a destructive fallback: unsent scans live here
        .build()
    val dao = db.dao()

    // Declaration order matters: the store needs the settings (LAN cursors), SyncManager and the authorities need dbLock.
    val settings = AppSettings(app)

    /**
     * Serialises read-modify-write of local ticket rows: local scans, server answers, delta pages, upload
     * outcomes, LAN requests. Always taken before a Room transaction, never the other way round.
     */
    val dbLock = Mutex()

    val store = RoomStore(db, appVersion = BuildConfig.VERSION_CODE, clearLanCursors = settings::clearLanCursors)
    val config = ConfigRepository(db)
    val clock = OffsetClock()
    val monitor = ConnectionMonitor(app)
    val feedback = Feedback(app)
    private val http = TixHttpClient.create()

    /** User agent for GitHub requests: app name and version only, nothing personal. */
    val githubUserAgent = "tix-checkin/${BuildConfig.VERSION_NAME}"
    val githubUpdates = org.tix.checkin.update.GithubUpdateChecker(app, githubUserAgent, BuildConfig.VERSION_CODE)

    val sync = SyncManager(
        db = db, store = store, config = config, settings = settings, monitor = monitor, clock = clock,
        client = http, appVersion = BuildConfig.VERSION_NAME, appVersionCode = BuildConfig.VERSION_CODE,
        dbLock = dbLock, scope = scope,
        onUnpaired = {
            SyncScheduler.cancelAll(app)
            lan.reset()
            LanMasterService.stop(app)
        },
        // Unpair waiting for the operator: no background sync, no LAN master (its scans could not be uploaded either).
        onUnpairBlocked = {
            SyncScheduler.cancelAll(app)
            lan.reset()
            LanMasterService.stop(app)
        },
        onUnpairCancelled = { SyncScheduler.schedulePeriodic(app) },
    )

    val lan: LanManager by lazy {
        LanManager(app, config, settings, store, db, clock, dbLock, monitor, scope)
    }

    /**
     * Who decides a scan: the server when reachable (short timeout), then the LAN master (server down), and
     * finally this device alone.
     */
    val scans = ScanCoordinator(
        authority = FallbackScanAuthority(
            server = ServerScanAuthority(sync.api, store, lock = dbLock),
            local = LocalScanAuthority({ config.snapshot }, store, dbLock),
            link = monitor,
            store = store,
            lan = lan.clientAuthority,
        ),
        config = { config.snapshot },
        clock = clock,
    )

    init {
        scope.launch {
            store.ensureLanState()
            dao.deviceConfig()?.let { clock.offsetMillis = it.clockOffsetMs }
            config.reload()
            if (dao.deviceConfig() != null) SyncScheduler.schedulePeriodic(app)
            lan // start the status ticker
        }
    }
}

class TixApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
