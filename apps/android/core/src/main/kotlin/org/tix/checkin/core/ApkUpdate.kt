package org.tix.checkin.core

/**
 * Pure rules of the in-app update (download + install is Android code in `:app`). Kept here so they are unit-tested.
 */
object ApkUpdate {
    /** Hard cap on what is downloaded, whatever the server announces (the release APK is about 50 MB). */
    const val MAX_APK_BYTES = 300L * 1024 * 1024

    fun isNewer(installedVersionCode: Int, latestVersionCode: Int): Boolean = latestVersionCode > installedVersionCode

    /** Lower-case 64 hex digits from `abc..`, `sha256:ABC..` or `AB:CD:..` text; null when it is not a SHA-256. */
    fun normalizeSha256(text: String): String? {
        val t = text.trim().removePrefix("sha256:").removePrefix("SHA256:").filter { it != ':' && !it.isWhitespace() }.lowercase()
        return t.takeIf { it.length == 64 && it.all { c -> c in '0'..'9' || c in 'a'..'f' } }
    }

    /** false for a blank/malformed expected value too: an update without a checksum is never installed. */
    fun sha256Matches(expected: String, actualHex: String): Boolean {
        val e = normalizeSha256(expected) ?: return false
        return e == actualHex.lowercase()
    }

    /** Most bytes accepted for a download: the announced size (+ tolerance) when known, otherwise the hard cap. */
    fun downloadLimit(announcedSizeBytes: Long): Long =
        if (announcedSizeBytes > 0) minOf(MAX_APK_BYTES, announcedSizeBytes + 64 * 1024) else MAX_APK_BYTES

    /** What to do before an update is installed. */
    enum class Gate { PROCEED, WARN_UNSENT_SCANS }

    fun gate(unsentScans: Int, warnedAlready: Boolean): Gate =
        if (unsentScans > 0 && !warnedAlready) Gate.WARN_UNSENT_SCANS else Gate.PROCEED

    /**
     * Why an installation failed, from `PackageInstaller.EXTRA_STATUS` (raw ints so this stays pure JVM):
     * STATUS_FAILURE=1, BLOCKED=2, ABORTED=3, INVALID=4, CONFLICT=5, STORAGE=6, INCOMPATIBLE=7.
     */
    enum class InstallFailure { SIGNATURE, USER_CANCELLED, STORAGE, BLOCKED, INVALID, OTHER }

    fun installFailure(status: Int): InstallFailure = when (status) {
        5, 7 -> InstallFailure.SIGNATURE // CONFLICT / INCOMPATIBLE: installed app is signed with another key (or newer)
        3 -> InstallFailure.USER_CANCELLED
        6 -> InstallFailure.STORAGE
        2 -> InstallFailure.BLOCKED
        4 -> InstallFailure.INVALID
        else -> InstallFailure.OTHER
    }
}
