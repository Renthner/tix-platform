package org.tix.checkin.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.IntentCompat
import java.io.File
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * Installs a downloaded APK with the PackageInstaller session API (robust on API 26-36 and on Samsung: no
 * FileProvider URI grants, no dependency on the browser or a file manager). The system asks the operator to confirm;
 * its answer arrives in [InstallResultReceiver] and is published on [results].
 */
object ApkInstaller {
    const val ACTION_RESULT = "org.tix.checkin.action.INSTALL_RESULT"

    class Result(val status: Int, val message: String?)

    private val _results = MutableSharedFlow<Result>(extraBufferCapacity = 8)
    val results: SharedFlow<Result> = _results

    internal fun report(status: Int, message: String?) {
        _results.tryEmit(Result(status, message))
    }

    /** false = the operator still has to allow "Install unknown apps" for this app (Android 8+). */
    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    /** The system page where this app can be allowed to install apps. */
    fun unknownSourcesIntent(context: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Streams [apk] into an install session and commits it. Throws on any failure before the system dialog. */
    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("tix-checkin.apk", 0, apk.length()).use { out ->
                        input.copyTo(out)
                        session.fsync(out)
                    }
                }
                // Explicit component + FLAG_MUTABLE: the system must add the status extras; implicit mutable
                // PendingIntents are refused from API 34.
                val intent = Intent(context, InstallResultReceiver::class.java).setAction(ACTION_RESULT)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
                session.commit(PendingIntent.getBroadcast(context, id, intent, flags).intentSender)
            }
        } catch (e: Exception) {
            try {
                installer.abandonSession(id)
            } catch (_: Exception) {
                // already closed
            }
            throw e
        }
    }
}

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
            if (confirm != null) {
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    ApkInstaller.report(PackageInstaller.STATUS_FAILURE, e.message)
                }
                return
            }
        }
        ApkInstaller.report(status, message)
    }
}
