package org.tix.checkin.core

import java.util.Base64

/**
 * RFC 4648 section 5 base64url WITHOUT padding. The decoder is strict, exactly like
 * `base64urlDecode` in packages/shared/src/tickets/qr.ts: only the unpadded URL-safe alphabet,
 * no length % 4 == 1, and the re-encoded value must equal the input (no non-canonical bits).
 */
object Base64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    /** Returns null for anything that is not canonical unpadded base64url. */
    fun decode(text: String): ByteArray? {
        if (text.length % 4 == 1) return null
        for (ch in text) {
            val ok = ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '-' || ch == '_'
            if (!ok) return null
        }
        val out = try {
            decoder.decode(text)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return if (encode(out) == text) out else null
    }
}
