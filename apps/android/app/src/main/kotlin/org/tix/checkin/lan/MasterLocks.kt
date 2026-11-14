package org.tix.checkin.lan

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Locks held while this device is the LAN master (see [LanMasterService]):
 *
 * - **WifiLocks**: without them the WiFi chip drops into power-save with the screen off and answers other doors'
 *   requests with seconds of delay or not at all. `WIFI_MODE_FULL_LOW_LATENCY` (API 29+) is, by the platform's
 *   definition, only effective while the screen is on and the app is in the foreground; `WIFI_MODE_FULL_HIGH_PERF`
 *   is what keeps the radio awake with the screen off. It is deprecated and a no-op from API 34, so on API 29-33
 *   BOTH are held, below 29 only high performance, on 34+ only low latency.
 * - **Partial wake lock**: the foreground service keeps the process alive, but not the CPU. A master lying on a desk
 *   with the screen off would let the CPU suspend and the server thread would only run when something else wakes it.
 *   The lock keeps the CPU (not the screen) running, only while master mode is on.
 *
 * All are non-reference-counted (acquire/release are idempotent). The wake lock has a safety timeout so a service
 * killed without [release] cannot hold the CPU forever; for a long event night the service calls [acquire] again
 * periodically: a non-reference-counted `acquire(timeout)` on a held lock restarts the timeout (it removes the pending
 * release and posts a new one), so the lock never expires while the master runs.
 */
class MasterLocks(context: Context) {
    private val app = context.applicationContext
    private var wifi: List<WifiManager.WifiLock> = emptyList()
    private var cpu: PowerManager.WakeLock? = null

    /** true while all locks are held. */
    val isHeld: Boolean
        @Synchronized get() = wifi.isNotEmpty() && wifi.all { it.isHeld } && cpu?.isHeld == true

    /** Takes the locks, or - when already held - renews the wake lock's timeout. */
    @Synchronized
    @SuppressLint("WakelockTimeout", "Wakelock")
    fun acquire() {
        try {
            if (wifi.isEmpty()) {
                val wm = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                wifi = wifiModes().mapNotNull { mode -> wm?.createWifiLock(mode, TAG)?.apply { setReferenceCounted(false) } }
            }
            wifi.forEach { if (!it.isHeld) it.acquire() }
        } catch (_: RuntimeException) {
            // no WiFi service / no permission: the master still works, only less reliably with the screen off
        }
        try {
            if (cpu == null) {
                val pm = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
                cpu = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG)?.apply { setReferenceCounted(false) }
            }
            cpu?.acquire(WAKE_LOCK_TIMEOUT_MILLIS) // held: restarts the timeout
        } catch (_: RuntimeException) {
            // see above
        }
    }

    /** Releases all, each independently (an exception on one never keeps another held). Safe to call twice. */
    @Synchronized
    fun release() {
        for (lock in wifi) {
            try {
                if (lock.isHeld) lock.release()
            } catch (_: RuntimeException) {
                // already released by the system
            }
        }
        try {
            if (cpu?.isHeld == true) cpu?.release()
        } catch (_: RuntimeException) {
            // already released by the system
        }
    }

    companion object {
        private const val TAG = "tix:lan-master"

        /** Frees the CPU by itself if the service dies without cleanup; the service renews it every [RENEW_MILLIS]. */
        const val WAKE_LOCK_TIMEOUT_MILLIS = 12 * 60 * 60_000L

        /** How often the running master calls [acquire] again (well inside [WAKE_LOCK_TIMEOUT_MILLIS]). */
        const val RENEW_MILLIS = 60 * 60_000L

        /** Wifi lock modes for [sdk]: see the class comment. */
        @Suppress("DEPRECATION")
        fun wifiModes(sdk: Int = Build.VERSION.SDK_INT): List<Int> = buildList {
            if (sdk >= 29) add(WifiManager.WIFI_MODE_FULL_LOW_LATENCY)
            if (sdk < 34) add(WifiManager.WIFI_MODE_FULL_HIGH_PERF)
        }

        /** Is this app exempt from battery optimisation (Doze / app standby)? */
        fun isIgnoringBatteryOptimizations(context: Context): Boolean =
            context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true

        /**
         * The system dialog "allow the app to run in the background" (one tap). Sideloaded app: the Play policy on this
         * permission does not apply. [batterySettingsIntent] is the fallback when the direct dialog does not exist.
         */
        fun requestIgnoreBatteryOptimizationsIntent(context: Context): Intent =
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))

        fun batterySettingsIntent(): Intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    }
}
