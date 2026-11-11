package org.tix.checkin.core.lan

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerializationException
import org.tix.checkin.core.Base64Url
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.ScannerJson
import org.tix.checkin.core.scan.ConfigSnapshot

/** HTTP-level answer (also what the in-process test wire returns). Header names are lower case. */
class WireResponse(val status: Int, val headers: Map<String, String> = emptyMap(), val body: ByteArray = ByteArray(0))

/** Sends one POST to a master. Implemented with plain sockets ([LanHttpClient]); faked in tests. */
interface LanWire {
    /** Throws [LanNetworkException] when no answer arrives within [timeoutMillis]. */
    suspend fun post(host: String, port: Int, path: String, headers: Map<String, String>, body: ByteArray, timeoutMillis: Long): WireResponse
}

/** Where a master listens. [deviceId] / [name] are unknown for a manually entered address until hello answered. */
data class LanEndpoint(val host: String, val port: Int, val deviceId: String? = null, val name: String? = null) {
    /** `host:port` as URL authority; an IPv6 literal gets its brackets (URI parsing, Host header). */
    val authority: String get() = (if (host.contains(':') && !host.startsWith("[")) "[$host]" else host) + ":$port"

    /** URL used for [org.tix.checkin.core.ServerUrlPolicy] (private / link-local / loopback only). */
    val policyUrl: String get() = "http://$authority"

    companion object {
        /**
         * Parses a manually entered address: `host`, `host:port`, `[v6]`, `[v6]:port` or a bare IPv6 literal
         * (several colons: no port can be told apart, [defaultPort] is used). Null when malformed.
         */
        fun parseManual(text: String, defaultPort: Int = LAN_DEFAULT_PORT): LanEndpoint? {
            val t = text.trim()
            if (t.isEmpty()) return null
            val host: String
            var port = defaultPort
            if (t.startsWith("[")) {
                val close = t.indexOf(']')
                if (close < 2) return null
                host = t.substring(1, close)
                val rest = t.substring(close + 1)
                if (rest.isNotEmpty()) {
                    if (!rest.startsWith(":")) return null
                    port = rest.substring(1).toIntOrNull() ?: return null
                }
            } else if (t.count { it == ':' } > 1) {
                host = t // bare IPv6 literal
            } else {
                val i = t.lastIndexOf(':')
                host = if (i > 0) t.substring(0, i) else t
                if (i > 0) port = t.substring(i + 1).toIntOrNull() ?: return null
            }
            if (host.isBlank() || host.any { it.isWhitespace() || it == '/' || it == '@' } || port !in 1..65535) return null
            return LanEndpoint(host, port)
        }
    }
}

open class LanException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** Connection failure or timeout: the master is unreachable. */
class LanNetworkException(message: String, cause: Throwable? = null) : LanException(message, cause)

/** 401: the peer did not accept our key (this event). The master itself is reachable. */
open class LanUnauthorizedException(message: String = "LAN request refused") : LanException(message)

/** The peer holds another LAN secret (key id differs): this device or the master is outdated, sync with the server. */
class LanKeyMismatchException : LanUnauthorizedException("LAN key outdated")

/** The peer's clock differs by more than the clock window: check the time settings of this device or the master. */
class LanClockException : LanUnauthorizedException("LAN clock differs")

/** This device has no LAN secret for the event (LAN disabled, or not delivered yet). */
class LanNoSecretException(eventId: String) : LanException("no LAN secret for event $eventId")

class LanProtocolException(message: String, cause: Throwable? = null) : LanException(message, cause)

/** Thrown by a [LanHandler] for a malformed request body: answered with 400. */
class LanBadRequestException(message: String) : Exception(message)

/** Thrown by a [LanHandler] for an unknown path: answered with 404. */
class LanNotFoundException(message: String) : Exception(message)

/** The master's application logic behind the envelope. */
interface LanHandler {
    /** [body] is the decrypted request; the result is the plain response body. */
    suspend fun handle(path: String, eventId: String, deviceId: String, body: ByteArray): ByteArray
}

/**
 * Receiving side of the envelope: authenticates (event key id, clock window, AES-GCM tag, replay), routes
 * to the [handler] and seals the answer. Pure (no sockets): the embedded server and the tests call [process].
 * Every authentication problem is a bare 401; only a key id mismatch adds `X-Tix-Error: key-mismatch`
 * (the key id is a hash prefix of the secret and reveals nothing usable).
 */
class LanRequestProcessor(
    private val selfDeviceId: () -> String,
    private val secretFor: (eventId: String) -> ByteArray?,
    private val clock: Clock,
    private val handler: LanHandler,
    private val replay: NonceCache = NonceCache(),
    private val onAuthenticated: (deviceId: String) -> Unit = {},
) {
    suspend fun process(method: String, path: String, headers: Map<String, String>, body: ByteArray): WireResponse {
        val eventId = headers[LanCrypto.HEADER_EVENT]
        val deviceId = headers[LanCrypto.HEADER_DEVICE]
        val ts = headers[LanCrypto.HEADER_TS]?.toLongOrNull()
        val nonceText = headers[LanCrypto.HEADER_NONCE]
        val nonce = nonceText?.let { Base64Url.decode(it) }
        if (eventId.isNullOrEmpty() || deviceId.isNullOrEmpty() || ts == null || nonce == null || nonceText == null || method != "POST") {
            return unauthorized()
        }
        val secret = secretFor(eventId) ?: return unauthorized()
        val senderKey = headers[LanCrypto.HEADER_KEY]
        if (senderKey != null && senderKey != LanCrypto.keyId(secret)) return unauthorized(keyMismatch = true)
        val now = clock.nowMillis()
        // Reported (like the key id) so the operator learns why LAN fails; the check runs before any decryption.
        if (kotlin.math.abs(now - ts) > LanCrypto.CLOCK_WINDOW_MILLIS) return unauthorized(clock = true)
        val key = LanCrypto.deriveKey(secret)
        val plain = LanCrypto.open(key, nonce, LanCrypto.requestAad(method, path, eventId, ts, deviceId), body)
            ?: return unauthorized()
        if (!replay.checkAndAdd("$deviceId:$nonceText", now)) return unauthorized()
        onAuthenticated(deviceId)

        val answer = try {
            handler.handle(path, eventId, deviceId, plain)
        } catch (e: CancellationException) {
            throw e
        } catch (_: LanBadRequestException) {
            return WireResponse(400)
        } catch (_: LanNotFoundException) {
            return WireResponse(404)
        } catch (_: SerializationException) {
            return WireResponse(400)
        } catch (_: Exception) {
            return WireResponse(500)
        }
        val self = selfDeviceId()
        val rts = clock.nowMillis()
        val rnonce = LanCrypto.newNonce()
        val sealed = LanCrypto.seal(key, rnonce, LanCrypto.responseAad(path, eventId, rts, self, nonceText), answer)
        return WireResponse(
            200,
            mapOf(
                LanCrypto.HEADER_EVENT to eventId,
                LanCrypto.HEADER_DEVICE to self,
                LanCrypto.HEADER_TS to rts.toString(),
                LanCrypto.HEADER_NONCE to Base64Url.encode(rnonce),
            ),
            sealed,
        )
    }

    private fun unauthorized(keyMismatch: Boolean = false, clock: Boolean = false) = WireResponse(
        401,
        when {
            keyMismatch -> mapOf(LanCrypto.HEADER_ERROR to LanCrypto.ERROR_KEY_MISMATCH)
            clock -> mapOf(LanCrypto.HEADER_ERROR to LanCrypto.ERROR_CLOCK)
            else -> emptyMap()
        },
    )
}

/** Sending side: seals requests, verifies and opens answers. */
class LanClient(
    private val wire: LanWire,
    private val clock: Clock,
    private val config: () -> ConfigSnapshot,
) {
    /** One encrypted round trip; returns the plain response body. */
    suspend fun call(endpoint: LanEndpoint, path: String, eventId: String, plainBody: ByteArray, timeoutMillis: Long): ByteArray =
        callRaw(endpoint, path, eventId, plainBody, timeoutMillis).first

    /**
     * Like [call], also returns the answering device id (authenticated: it is part of the response AAD). When
     * the endpoint's device id is known (DNS-SD advert, or learned by an earlier hello) the answer must come
     * from exactly that device. The whole round trip has a hard deadline: a trickling peer cannot exceed it.
     */
    private suspend fun callRaw(endpoint: LanEndpoint, path: String, eventId: String, plainBody: ByteArray, timeoutMillis: Long): Pair<ByteArray, String> {
        val cfg = config()
        val secret = cfg.events[eventId]?.lanSecret ?: throw LanNoSecretException(eventId)
        val deviceId = cfg.deviceId
        val key = LanCrypto.deriveKey(secret)
        val ts = clock.nowMillis()
        val nonce = LanCrypto.newNonce()
        val nonceText = Base64Url.encode(nonce)
        val sealed = LanCrypto.seal(key, nonce, LanCrypto.requestAad("POST", path, eventId, ts, deviceId), plainBody)
        val response = try {
            // A timeout is a CancellationException: convert it, or the scan chain would skip its local fallback.
            withTimeout(timeoutMillis) {
                wire.post(
                    endpoint.host, endpoint.port, path,
                    mapOf(
                        LanCrypto.HEADER_EVENT to eventId,
                        LanCrypto.HEADER_DEVICE to deviceId,
                        LanCrypto.HEADER_TS to ts.toString(),
                        LanCrypto.HEADER_NONCE to nonceText,
                        LanCrypto.HEADER_KEY to LanCrypto.keyId(secret),
                    ),
                    sealed, timeoutMillis,
                )
            }
        } catch (e: TimeoutCancellationException) {
            throw LanNetworkException("LAN request timed out", e)
        }
        if (response.status == 401) {
            when (response.headers[LanCrypto.HEADER_ERROR]) {
                LanCrypto.ERROR_KEY_MISMATCH -> throw LanKeyMismatchException()
                LanCrypto.ERROR_CLOCK -> throw LanClockException()
            }
            throw LanUnauthorizedException()
        }
        if (response.status != 200) throw LanProtocolException("LAN status ${response.status}")
        val rts = response.headers[LanCrypto.HEADER_TS]?.toLongOrNull() ?: throw LanProtocolException("missing timestamp")
        val rnonce = response.headers[LanCrypto.HEADER_NONCE]?.let { Base64Url.decode(it) } ?: throw LanProtocolException("missing nonce")
        val rdevice = response.headers[LanCrypto.HEADER_DEVICE] ?: throw LanProtocolException("missing device")
        if (kotlin.math.abs(clock.nowMillis() - rts) > LanCrypto.CLOCK_WINDOW_MILLIS) throw LanProtocolException("answer outside the clock window")
        // Opening proves the sender holds the event secret; the device id binds the answer to one master.
        val plain = LanCrypto.open(key, rnonce, LanCrypto.responseAad(path, eventId, rts, rdevice, nonceText), response.body)
            ?: throw LanProtocolException("answer not authentic")
        if (endpoint.deviceId != null && rdevice != endpoint.deviceId) throw LanProtocolException("answer from another device")
        return plain to rdevice
    }

    private suspend inline fun <reified Q, reified R> typed(endpoint: LanEndpoint, path: String, eventId: String, request: Q, timeoutMillis: Long): R {
        val plain = call(endpoint, path, eventId, ScannerJson.encodeToString(request).toByteArray(Charsets.UTF_8), timeoutMillis)
        return try {
            ScannerJson.decodeFromString<R>(plain.toString(Charsets.UTF_8))
        } catch (e: SerializationException) {
            throw LanProtocolException("undecodable answer", e)
        }
    }

    /**
     * A valid hello: decryption succeeded (proves the secret), and the device id inside equals the authenticated
     * response header (and the advertised id, if known).
     */
    suspend fun hello(endpoint: LanEndpoint, eventId: String, deviceName: String, timeoutMillis: Long = 800): LanHello {
        val (plain, rdevice) = callRaw(
            endpoint, LanPaths.HELLO, eventId, ScannerJson.encodeToString(LanHelloRequest(deviceName)).toByteArray(Charsets.UTF_8), timeoutMillis,
        )
        val hello = try {
            ScannerJson.decodeFromString<LanHello>(plain.toString(Charsets.UTF_8))
        } catch (e: SerializationException) {
            throw LanProtocolException("undecodable answer", e)
        }
        if (hello.deviceId.isBlank() || hello.deviceId != rdevice) throw LanProtocolException("hello device id mismatch")
        return hello
    }

    suspend fun scan(endpoint: LanEndpoint, eventId: String, request: LanScanRequest, timeoutMillis: Long = 800): LanScanResponse =
        typed(endpoint, LanPaths.SCAN, eventId, request, timeoutMillis)

    suspend fun sync(endpoint: LanEndpoint, eventId: String, request: LanSyncRequest, timeoutMillis: Long = 3_000): LanSyncResponse =
        typed(endpoint, LanPaths.SYNC, eventId, request, timeoutMillis)

    suspend fun push(endpoint: LanEndpoint, eventId: String, request: LanPushRequest, timeoutMillis: Long = 3_000): LanPushResponse =
        typed(endpoint, LanPaths.SCANS, eventId, request, timeoutMillis)
}
