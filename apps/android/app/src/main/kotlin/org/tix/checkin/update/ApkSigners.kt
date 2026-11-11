package org.tix.checkin.update

import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest
import org.tix.checkin.core.ApkUpdate

/** Signing certificates of the installed app and of a downloaded APK (selection rules: [ApkUpdate.chooseSigners]). */
object ApkSigners {
    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun installed(pm: PackageManager, packageName: String): ApkUpdate.Signers = try {
        collect(pm.getPackageInfo(packageName, FLAGS))
    } catch (_: PackageManager.NameNotFoundException) {
        ApkUpdate.Signers(emptySet())
    }

    /** Signers of the APK file; empty when it cannot be read or is unsigned. */
    fun archive(pm: PackageManager, path: String): ApkUpdate.Signers =
        pm.getPackageArchiveInfo(path, FLAGS)?.let { collect(it) } ?: ApkUpdate.Signers(emptySet())

    // Both flags: on API 28/29 an archive can come back with signingInfo == null but with legacy signatures.
    @Suppress("DEPRECATION")
    private val FLAGS: Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
        } else {
            PackageManager.GET_SIGNATURES
        }

    @Suppress("DEPRECATION")
    private fun collect(info: PackageInfo): ApkUpdate.Signers {
        var current: List<String>? = null
        var history: List<String>? = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.let { signing ->
                current = signing.apkContentsSigners?.map { sha256(it.toByteArray()) }
                history = if (signing.hasMultipleSigners()) null else signing.signingCertificateHistory?.map { sha256(it.toByteArray()) }
            }
        }
        val legacy = info.signatures?.map { sha256(it.toByteArray()) }
        return ApkUpdate.chooseSigners(current, history, legacy)
    }
}
