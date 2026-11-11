package org.tix.checkin.core

import java.net.URI
import java.net.URISyntaxException

/**
 * Decides which server URLs the app may talk to.
 *
 *  - `https://` is allowed for any host.
 *  - `http://` (cleartext) is allowed ONLY for hosts on the local network: private IPv4
 *    (10/8, 172.16/12, 192.168/16, which includes the emulator host 10.0.2.2), loopback
 *    (127/8, `localhost`, `::1`), link-local (169.254/16, `fe80::/10`) and mDNS `.local` names.
 *  - Everything else (other schemes, user-info in the URL, public hosts over http) is refused.
 *
 * Android's network-security-config cannot express IP ranges, so cleartext is permitted
 * globally in the manifest and this policy is enforced in the HTTP client layer.
 */
object ServerUrlPolicy {
    sealed interface Decision {
        data object Allowed : Decision
        data class Refused(val reason: Reason) : Decision
    }

    enum class Reason { INVALID_URL, UNSUPPORTED_SCHEME, USER_INFO, CLEARTEXT_NOT_LOCAL }

    fun check(url: String): Decision {
        val uri = try {
            URI(url.trim())
        } catch (_: URISyntaxException) {
            return Decision.Refused(Reason.INVALID_URL)
        }
        val scheme = uri.scheme?.lowercase() ?: return Decision.Refused(Reason.INVALID_URL)
        if (scheme != "http" && scheme != "https") return Decision.Refused(Reason.UNSUPPORTED_SCHEME)
        if (uri.rawUserInfo != null) return Decision.Refused(Reason.USER_INFO)
        val host = uri.host?.takeIf { it.isNotBlank() } ?: return Decision.Refused(Reason.INVALID_URL)
        if (scheme == "https") return Decision.Allowed
        return if (isLocalHost(host)) Decision.Allowed else Decision.Refused(Reason.CLEARTEXT_NOT_LOCAL)
    }

    fun isAllowed(url: String): Boolean = check(url) == Decision.Allowed

    /** True for private/loopback/link-local IPs, `localhost` and `.local` names. */
    fun isLocalHost(rawHost: String): Boolean {
        var host = rawHost.lowercase().trimEnd('.')
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
        if (host == "localhost" || host.endsWith(".localhost")) return true
        parseIpv4(host)?.let { return isLocalIpv4(it) }
        if (host.contains(':')) return isLocalIpv6(host)
        // A host name: only mDNS names qualify ("192.168.1.5.example.com" is just a name).
        return host.endsWith(".local") && host.length > ".local".length
    }

    private fun parseIpv4(host: String): IntArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for ((i, p) in parts.withIndex()) {
            if (p.isEmpty() || p.length > 3 || !p.all { it in '0'..'9' }) return null
            val n = p.toInt()
            if (n > 255) return null
            out[i] = n
        }
        return out
    }

    private fun isLocalIpv4(o: IntArray): Boolean = when {
        o[0] == 10 -> true
        o[0] == 172 && o[1] in 16..31 -> true
        o[0] == 192 && o[1] == 168 -> true
        o[0] == 127 -> true
        o[0] == 169 && o[1] == 254 -> true
        else -> false
    }

    /** `::1` and `fe80::/10`. Only characters valid in an IPv6 literal are accepted. */
    private fun isLocalIpv6(host: String): Boolean {
        val bare = host.substringBefore('%') // zone id, e.g. fe80::1%wlan0
        if (!bare.all { it in '0'..'9' || it in 'a'..'f' || it == ':' }) return false
        if (bare == "::1") return true
        val first = bare.substringBefore(':')
        val value = first.toIntOrNull(16) ?: return false
        return first.length in 1..4 && value in 0xfe80..0xfebf
    }
}
