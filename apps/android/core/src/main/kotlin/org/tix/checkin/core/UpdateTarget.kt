package org.tix.checkin.core

/**
 * The app follows the server: the version to run is exactly the version the server reports in its manifest
 * (`serverVersion`). Android cannot downgrade without an uninstall (which would wipe the offline data), so a
 * newer app is never offered an "update".
 */
sealed interface UpdateTarget {
    data object UpToDate : UpdateTarget
    data class UpdateAvailable(val target: AppVersion) : UpdateTarget
    data class AppNewerThanServer(val server: AppVersion) : UpdateTarget

    /** Older server without the field, or an unparsable value: the channel logic applies. */
    data object UnknownServerVersion : UpdateTarget

    companion object {
        fun decide(installed: AppVersion, serverVersion: String?): UpdateTarget {
            val server = serverVersion?.trim()?.takeIf { it.isNotEmpty() }?.let { AppVersion.parse(it) } ?: return UnknownServerVersion
            return when {
                installed == server -> UpToDate
                server > installed -> UpdateAvailable(server)
                else -> AppNewerThanServer(server)
            }
        }
    }
}
