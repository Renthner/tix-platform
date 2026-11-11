package org.tix.checkin.core

import java.net.URLDecoder

/** Pairing QR / manual code handling (port of packages/shared/src/scanner/pairing.ts). */
object Pairing {
    const val URI_PREFIX = "tixscan://pair"
    const val CODE_LENGTH = 10
    const val SUPPORTED_VERSION = "1"

    data class Target(val serverUrl: String, val code: String)

    /** Normalises typed input (case, spaces, dashes, Crockford aliases O->0, I/L->1). */
    fun normalizeCode(input: String): String =
        input.uppercase().replace(Regex("[\\s-]+"), "").replace('O', '0').replace(Regex("[IL]"), "1")

    /** `ABCDE-FGHJK` */
    fun formatCode(code: String): String = if (code.length == CODE_LENGTH) "${code.substring(0, 5)}-${code.substring(5)}" else code

    /** Parses `tixscan://pair?v=1&u=<url>&c=<CODE>`; null for anything else (other version too). */
    fun parseUri(text: String): Target? {
        val trimmed = text.trim()
        if (!trimmed.startsWith("$URI_PREFIX?")) return null
        val params = HashMap<String, String>()
        for (pair in trimmed.substring(URI_PREFIX.length + 1).split('&')) {
            if (pair.isEmpty()) continue
            val idx = pair.indexOf('=')
            val key = if (idx < 0) pair else pair.substring(0, idx)
            val value = if (idx < 0) "" else pair.substring(idx + 1)
            try {
                params[URLDecoder.decode(key, "UTF-8")] = URLDecoder.decode(value, "UTF-8")
            } catch (_: IllegalArgumentException) {
                return null
            }
        }
        val url = params["u"]?.takeIf { it.isNotBlank() } ?: return null
        val code = params["c"] ?: return null
        if (params["v"] != SUPPORTED_VERSION) return null
        val normalized = normalizeCode(code)
        if (normalized.length != CODE_LENGTH) return null
        return Target(url.trim().trimEnd('/'), normalized)
    }
}
