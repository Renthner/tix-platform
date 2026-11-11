package org.tix.checkin.lan

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.tix.checkin.MainActivity
import org.tix.checkin.R
import org.tix.checkin.TixApplication

/**
 * Keeps the process (and with it the LAN master server owned by [LanManager]) alive while master mode is
 * on. Type `connectedDevice`: the service serves other devices over the local network (its prerequisite
 * permission is CHANGE_WIFI_MULTICAST_STATE). `dataSync` is deliberately not used: Android 15 limits it
 * to a few hours per day. Start it only while the app is visible (Android 12+ background start limits).
 */
class LanMasterService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loop: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.lan_channel_name), NotificationManager.IMPORTANCE_LOW),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.lan_notification_title))
            .setContentText(getString(R.string.lan_notification_text))
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        val container = (application as TixApplication).container
        val lan = container.lan
        loop?.cancel()
        loop = scope.launch {
            // After a sticky restart the process starts cold: the paired configuration is loaded asynchronously.
            if (!lan.awaitConfig() || !lan.startMaster()) {
                stopSelf()
                return@launch
            }
            // While master mode is on, this device keeps the server sync going - also with the app in the
            // background (the master must know the other doors' tickets and cancellations). Coalesces with the
            // activity's own loop.
            container.sync.runLoop()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        loop?.cancel()
        scope.cancel()
        (application as TixApplication).container.lan.stopMaster()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "lan_master"
        private const val NOTIFICATION_ID = 4780

        /** Must be called while the app is in the foreground. Failures (background restrictions) are ignored. */
        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(context, Intent(context, LanMasterService::class.java))
            } catch (_: RuntimeException) {
                // not allowed right now: retried when the app becomes visible
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LanMasterService::class.java))
        }
    }
}
