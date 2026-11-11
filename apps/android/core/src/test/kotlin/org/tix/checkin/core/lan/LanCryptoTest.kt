package org.tix.checkin.core.lan

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.tix.checkin.core.Base64Url
import org.tix.checkin.core.contract.Clock

private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }

class LanCryptoTest {
    private val secret = ByteArray(32) { it.toByte() }
    private val key = LanCrypto.deriveKey(secret)

    @Test
    fun `hkdf matches RFC 5869 test case 1`() {
        val okm = LanCrypto.hkdfSha256(
            ByteArray(22) { 0x0b },
            hex("000102030405060708090a0b0c"),
            hex("f0f1f2f3f4f5f6f7f8f9"),
            42,
        )
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            okm.toHex(),
        )
    }

    @Test
    fun `derived key is 32 bytes, deterministic and secret dependent`() {
        assertEquals(32, key.size)
        assertContentEquals(key, LanCrypto.deriveKey(secret))
        assertFalse(key.contentEquals(LanCrypto.deriveKey(ByteArray(32) { 9 })))
        assertFalse(key.contentEquals(secret))
    }

    @Test
    fun `key id is stable, short and differs between secrets`() {
        val id = LanCrypto.keyId(secret)
        assertEquals(id, LanCrypto.keyId(secret))
        assertEquals(11, id.length) // 8 bytes unpadded base64url
        assertNotEquals(id, LanCrypto.keyId(ByteArray(32) { 9 }))
    }

    @Test
    fun `seal and open round trip`() {
        val nonce = LanCrypto.newNonce()
        val aad = LanCrypto.requestAad("POST", "/lan/v1/scan", "E", 5, "dev")
        val sealed = LanCrypto.seal(key, nonce, aad, "hello".toByteArray())
        assertEquals("hello", LanCrypto.open(key, nonce, aad, sealed)!!.toString(Charsets.UTF_8))
        assertNotEquals("hello", sealed.toString(Charsets.UTF_8))
    }

    @Test
    fun `tampered body, nonce, aad part or wrong key fail`() {
        val nonce = LanCrypto.newNonce()
        val aad = LanCrypto.requestAad("POST", "/lan/v1/scan", "E", 5, "dev")
        val sealed = LanCrypto.seal(key, nonce, aad, "hello".toByteArray())
        val flipped = sealed.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertNull(LanCrypto.open(key, nonce, aad, flipped))
        assertNull(LanCrypto.open(key, nonce.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }, aad, sealed))
        for (other in listOf(
            LanCrypto.requestAad("GET", "/lan/v1/scan", "E", 5, "dev"),
            LanCrypto.requestAad("POST", "/lan/v1/sync", "E", 5, "dev"),
            LanCrypto.requestAad("POST", "/lan/v1/scan", "F", 5, "dev"),
            LanCrypto.requestAad("POST", "/lan/v1/scan", "E", 6, "dev"),
            LanCrypto.requestAad("POST", "/lan/v1/scan", "E", 5, "other"),
        )) assertNull(LanCrypto.open(key, nonce, other, sealed))
        assertNull(LanCrypto.open(LanCrypto.deriveKey(ByteArray(32) { 9 }), nonce, aad, sealed))
        assertNull(LanCrypto.open(key, nonce, aad, ByteArray(3)))
    }

    @Test
    fun `nonce cache rejects replays and forgets old and excess entries`() {
        val c = NonceCache(capacity = 3, ttlMillis = 1000)
        assertTrue(c.checkAndAdd("a", 0))
        assertFalse(c.checkAndAdd("a", 10))
        assertTrue(c.checkAndAdd("a", 2000)) // expired, accepted again
        assertTrue(c.checkAndAdd("b", 2001)); assertTrue(c.checkAndAdd("c", 2002)); assertTrue(c.checkAndAdd("d", 2003))
        assertTrue(c.checkAndAdd("a", 2004)) // evicted by capacity (LRU)
    }
}

/** The processor + client pair without sockets. */
class LanEnvelopeTest {
    private class Now(var t: Long = 1_800_000_000_000) : Clock {
        override fun nowMillis() = t
    }

    private val secret = ByteArray(32) { it.toByte() }
    private val clock = Now()
    private val echo = object : LanHandler {
        var calls = 0
        override suspend fun handle(path: String, eventId: String, deviceId: String, body: ByteArray): ByteArray {
            calls++
            return when (path) {
                "/lan/v1/missing" -> throw LanNotFoundException(path)
                "/lan/v1/bad" -> throw LanBadRequestException("x")
                else -> body.reversedArray()
            }
        }
    }
    private val processor = LanRequestProcessor({ "master" }, { if (it == "E") secret else null }, clock, echo)

    private fun cfg(s: ByteArray?, device: String = "c1") = org.tix.checkin.core.scan.ConfigSnapshot(
        offlineModeAllowed = true, deviceName = "n", deviceId = device,
        events = mapOf(
            "E" to org.tix.checkin.core.scan.EventConfig("E", "t", null, false, emptyMap(), emptyMap(), emptyMap(), lanSecret = s),
            "F" to org.tix.checkin.core.scan.EventConfig("F", "t", null, false, emptyMap(), emptyMap(), emptyMap(), lanSecret = s),
        ),
    )

    /** Wire that records the last request and can replay or alter it. */
    private inner class Wire(var tamper: (WireResponse) -> WireResponse = { it }) : LanWire {
        var lastHeaders: Map<String, String> = emptyMap()
        var lastBody = ByteArray(0)
        var lastPath = ""
        override suspend fun post(host: String, port: Int, path: String, headers: Map<String, String>, body: ByteArray, timeoutMillis: Long): WireResponse {
            lastHeaders = headers; lastBody = body; lastPath = path
            return tamper(processor.process("POST", path, headers, body))
        }
    }

    private fun client(wire: LanWire, s: ByteArray? = secret, device: String = "c1") =
        LanClient(wire, clock) { cfg(s, device) }

    private val ep = LanEndpoint("h", 1)

    @Test
    fun `round trip, handler sees plain body`() = runBlocking {
        val r = client(Wire()).call(ep, "/lan/v1/scan", "E", "abc".toByteArray(), 500)
        assertEquals("cba", r.toString(Charsets.UTF_8))
        assertEquals(1, echo.calls)
    }

    @Test
    fun `wire body is not plain text`() = runBlocking {
        val w = Wire()
        client(w).call(ep, "/lan/v1/scan", "E", "secret-ticket-data".toByteArray(), 500)
        assertFalse(w.lastBody.toString(Charsets.ISO_8859_1).contains("secret-ticket"))
    }

    @Test
    fun `wrong secret is a bare 401 without detail`() = runBlocking {
        // Same key id impossible: the client sends its own key id, which differs -> key mismatch signalled.
        val ex = runCatching { client(Wire(), ByteArray(32) { 7 }).call(ep, "/lan/v1/scan", "E", ByteArray(1), 500) }.exceptionOrNull()
        assertTrue(ex is LanKeyMismatchException)
        // Without a key id header (hostile client) the answer carries no detail at all.
        val r = processor.process(
            "POST", "/lan/v1/scan",
            mapOf("x-tix-event" to "E", "x-tix-device" to "d", "x-tix-ts" to clock.t.toString(), "x-tix-nonce" to Base64Url.encode(ByteArray(12))),
            ByteArray(20),
        )
        assertEquals(401, r.status)
        assertTrue(r.headers.isEmpty() && r.body.isEmpty())
        assertEquals(0, echo.calls)
    }

    @Test
    fun `unknown event is refused like a wrong key`() = runBlocking {
        val ex = runCatching { client(Wire()).call(ep, "/lan/v1/scan", "F", ByteArray(1), 500) }.exceptionOrNull()
        assertTrue(ex is LanUnauthorizedException && ex !is LanKeyMismatchException)
    }

    @Test
    fun `missing secret fails before any network`() = runBlocking {
        val ex = runCatching { client(Wire(), s = null).call(ep, "/lan/v1/scan", "E", ByteArray(1), 500) }.exceptionOrNull()
        assertTrue(ex is LanNoSecretException)
    }

    @Test
    fun `replayed request is refused`() = runBlocking {
        val w = Wire()
        client(w).call(ep, "/lan/v1/scan", "E", "a".toByteArray(), 500)
        val again = processor.process("POST", w.lastPath, w.lastHeaders, w.lastBody)
        assertEquals(401, again.status)
        assertEquals(1, echo.calls)
    }

    @Test
    fun `tampered body, path or method is refused`() = runBlocking {
        val w = Wire()
        client(w).call(ep, "/lan/v1/scan", "E", "a".toByteArray(), 500)
        val h = w.lastHeaders.toMutableMap().also { it["x-tix-nonce"] = Base64Url.encode(LanCrypto.newNonce()) }
        assertEquals(401, processor.process("POST", "/lan/v1/scan", h, w.lastBody.copyOf().also { it[0] = 0 }).status)
        // The same sealed bytes for another path (nonce differs from the first use, so replay is not the reason).
        val w2 = Wire()
        client(w2).call(ep, "/lan/v1/scan", "E", "a".toByteArray(), 500)
        assertEquals(401, processor.process("POST", "/lan/v1/sync", w2.lastHeaders, w2.lastBody).status)
        assertEquals(401, processor.process("GET", "/lan/v1/scan", w2.lastHeaders, w2.lastBody).status)
    }

    @Test
    fun `timestamp outside the window is refused, inside is accepted`() = runBlocking {
        val c = client(Wire())
        val w = Wire()
        val c2 = client(w)
        c2.call(ep, "/lan/v1/scan", "E", ByteArray(1), 500)
        // Receiver clock moved on by 61 s: the stored request is now too old.
        clock.t += 61_000
        assertEquals(401, processor.process("POST", w.lastPath, w.lastHeaders, w.lastBody).status)
        // A fresh request after the move works (both use the same clock).
        c.call(ep, "/lan/v1/scan", "E", ByteArray(1), 500)
        // Skew just inside the window.
        val skewed = LanClient(Wire(), object : Clock { override fun nowMillis() = clock.t + 59_000 }) { cfg(secret) }
        skewed.call(ep, "/lan/v1/scan", "E", ByteArray(1), 500)
        val tooSkewed = LanClient(Wire(), object : Clock { override fun nowMillis() = clock.t + 61_000 }) { cfg(secret) }
        assertTrue(runCatching { tooSkewed.call(ep, "/lan/v1/scan", "E", ByteArray(1), 500) }.exceptionOrNull() is LanUnauthorizedException)
    }

    @Test
    fun `a response cannot be replayed as the answer to another request`() = runBlocking {
        val first = Wire()
        client(first).call(ep, "/lan/v1/scan", "E", "one".toByteArray(), 500)
        var captured: WireResponse? = null
        val recorder = Wire { r -> r.also { captured = it } }
        client(recorder).call(ep, "/lan/v1/scan", "E", "one".toByteArray(), 500)
        val old = captured!!
        val replaying = Wire { old }
        val ex = runCatching { client(replaying).call(ep, "/lan/v1/scan", "E", "one".toByteArray(), 500) }.exceptionOrNull()
        assertTrue(ex is LanProtocolException)
    }

    @Test
    fun `tampered answer is refused`() = runBlocking {
        val w = Wire { r -> WireResponse(r.status, r.headers, r.body.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }) }
        assertTrue(runCatching { client(w).call(ep, "/lan/v1/scan", "E", ByteArray(1), 500) }.exceptionOrNull() is LanProtocolException)
    }

    @Test
    fun `handler errors map to status codes`() = runBlocking {
        assertTrue(runCatching { client(Wire()).call(ep, "/lan/v1/missing", "E", ByteArray(1), 500) }.exceptionOrNull() is LanProtocolException)
        val w = Wire()
        runCatching { client(w).call(ep, "/lan/v1/bad", "E", ByteArray(1), 500) }
        assertNotNull(w.lastHeaders[LanCrypto.HEADER_KEY])
    }
}
