package org.tix.checkin.core.lan

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.tix.checkin.core.Base64Url

/** Envelope crypto of the LAN protocol (docs/LAN.md): HKDF-SHA256 key, AES-256-GCM, bound AAD. */
object LanCrypto {
    const val VERSION = "tix-lan-v1"
    const val NONCE_BYTES = 12
    const val TAG_BITS = 128

    /** Receivers accept timestamps within this window around their own (server-corrected) clock. */
    const val CLOCK_WINDOW_MILLIS = 60_000L

    const val HEADER_EVENT = "x-tix-event"
    const val HEADER_DEVICE = "x-tix-device"
    const val HEADER_TS = "x-tix-ts"
    const val HEADER_NONCE = "x-tix-nonce"
    const val HEADER_KEY = "x-tix-key"
    const val HEADER_ERROR = "x-tix-error"

    /** Value of [HEADER_ERROR] when the sender's key id differs from the receiver's current key. */
    const val ERROR_KEY_MISMATCH = "key-mismatch"

    /** Value of [HEADER_ERROR] when the request's timestamp is outside the clock window (clocks differ). */
    const val ERROR_CLOCK = "clock"

    private val random = SecureRandom()

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** RFC 5869 HKDF with SHA-256. */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..(255 * 32))
        val prk = hmacSha256(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val out = java.io.ByteArrayOutputStream()
        var t = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            t = hmacSha256(prk, t + info + byteArrayOf(counter.toByte()))
            out.write(t)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }

    /** AES-256 key of an event: HKDF-SHA256(lanSecret, info = "tix-lan-v1"). */
    fun deriveKey(secret: ByteArray): ByteArray =
        hkdfSha256(secret, ByteArray(0), VERSION.toByteArray(Charsets.UTF_8), 32)

    /**
     * Short public identifier of a secret (first 8 bytes of SHA-256, base64url). Lets a receiver tell
     * "the sender holds another (older/newer) secret" apart from tampering. Not usable to recover the secret.
     */
    fun keyId(secret: ByteArray): String =
        Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(secret).copyOf(8))

    fun requestAad(method: String, path: String, eventId: String, ts: Long, deviceId: String): ByteArray =
        "$VERSION\n$method\n$path\n$eventId\n$ts\n$deviceId".toByteArray(Charsets.UTF_8)

    /** The response is bound to the request it answers (its nonce) so an old answer cannot be replayed. */
    fun responseAad(path: String, eventId: String, ts: Long, deviceId: String, requestNonce: String): ByteArray =
        "$VERSION\nRESPONSE\n$path\n$eventId\n$ts\n$deviceId\n$requestNonce".toByteArray(Charsets.UTF_8)

    fun newNonce(): ByteArray = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }

    fun seal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(plaintext)
    }

    /** null = authentication failed (wrong key, tampered body or AAD). */
    fun open(key: ByteArray, nonce: ByteArray, aad: ByteArray, ciphertext: ByteArray): ByteArray? {
        if (nonce.size != NONCE_BYTES || ciphertext.size < TAG_BITS / 8) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
            cipher.updateAAD(aad)
            cipher.doFinal(ciphertext)
        } catch (_: java.security.GeneralSecurityException) {
            null
        }
    }
}

/** Remembers recently seen nonces (bounded LRU) to reject replayed requests inside the clock window. */
class NonceCache(private val capacity: Int = 10_000, private val ttlMillis: Long = 3 * LanCrypto.CLOCK_WINDOW_MILLIS) {
    private val seen = object : LinkedHashMap<String, Long>(256, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > capacity
    }

    /** true = fresh (now remembered), false = replay. */
    @Synchronized
    fun checkAndAdd(key: String, now: Long): Boolean {
        val it = seen.entries.iterator()
        while (it.hasNext()) { // insertion ordered: stop at the first entry that is still young
            if (now - it.next().value > ttlMillis) it.remove() else break
        }
        if (seen.containsKey(key)) return false
        seen[key] = now
        return true
    }
}
