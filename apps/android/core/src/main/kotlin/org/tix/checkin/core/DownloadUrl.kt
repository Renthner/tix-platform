package org.tix.checkin.core

/**
 * Resolves the update download link the server sent. The result is only ever opened in the browser when
 * [ServerUrlPolicy] accepts it (https, or http in the local network): a manipulated answer cannot send the
 * operator to another scheme (`file:`, `intent:`, ...) or to a cleartext public host.
 */
object DownloadUrl {
    /** [serverUrl] is the paired server address, used for relative links. Null = refuse. */
    fun resolve(serverUrl: String, link: String): String? {
        val u = link.trim()
        if (u.isEmpty()) return null
        val absolute = u.startsWith("http://", ignoreCase = true) || u.startsWith("https://", ignoreCase = true)
        val full = if (absolute) u else serverUrl.trim().trimEnd('/') + (if (u.startsWith("/")) u else "/$u")
        return full.takeIf { ServerUrlPolicy.isAllowed(it) }
    }
}
