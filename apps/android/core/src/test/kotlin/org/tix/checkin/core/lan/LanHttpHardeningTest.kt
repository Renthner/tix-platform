package org.tix.checkin.core.lan

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.Inet6Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.scan.EVENT_A
import org.tix.checkin.core.scan.config

private val secret = ByteArray(32) { (it + 7).toByte() }
private val clock = Clock { System.currentTimeMillis() }

/** A handler that throws whatever it is told to (also Errors, which the processor does not catch). */
private class ThrowingHandler(var error: Throwable? = null) : LanHandler {
    override suspend fun handle(path: String, eventId: String, deviceId: String, body: ByteArray): ByteArray {
        error?.let { throw it }
        return """{"protocol":1,"deviceId":"master","deviceName":"M"}""".toByteArray()
    }
}

private fun processor(handler: LanHandler) = LanRequestProcessor({ "master" }, { if (it == EVENT_A) secret else null }, clock, handler)

private fun waitUntil(timeoutMillis: Long = 3_000, cond: () -> Boolean): Boolean {
    val end = System.currentTimeMillis() + timeoutMillis
    while (System.currentTimeMillis() < end) {
        if (cond()) return true
        Thread.sleep(20)
    }
    return cond()
}

class LanSourcePolicyTest {
    private fun ok(s: String) = LanSourcePolicy.isLanSource(InetAddress.getByName(s))

    /** An IPv4-mapped IPv6 address that stays an Inet6Address (InetAddress.getByAddress would turn it into an Inet4Address). */
    private fun mapped(a: Int, b: Int, c: Int, d: Int): InetAddress =
        Inet6Address.getByAddress(null, byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, a.toByte(), b.toByte(), c.toByte(), d.toByte()), null)

    @Test
    fun `ipv4 peers reported as ipv4-mapped ipv6 are classified by their ipv4 address`() {
        assertTrue(mapped(192, 168, 1, 5) is Inet6Address, "the test must exercise the Inet6Address path")
        assertTrue(LanSourcePolicy.isLanSource(mapped(192, 168, 1, 5)))
        assertTrue(LanSourcePolicy.isLanSource(mapped(10, 0, 0, 1)))
        assertTrue(LanSourcePolicy.isLanSource(mapped(172, 20, 1, 1)))
        assertTrue(LanSourcePolicy.isLanSource(mapped(127, 0, 0, 1)))
        assertTrue(LanSourcePolicy.isLanSource(mapped(169, 254, 3, 3)))
        assertFalse(LanSourcePolicy.isLanSource(mapped(8, 8, 8, 8)))
        assertFalse(LanSourcePolicy.isLanSource(mapped(0, 0, 0, 0)))
    }

    @Test
    fun `only venue network sources are admitted`() {
        for (a in listOf("10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.9.9", "127.0.0.1", "::1", "fe80::1", "fd00::1", "fc00::5")) {
            assertTrue(ok(a), a)
        }
        for (a in listOf("8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", "2a00:1450::1", "0.0.0.0", "::")) {
            assertFalse(ok(a), a)
        }
    }
}

class LanHttpHardeningTest {
    private fun server(
        handler: LanHandler = ThrowingHandler(),
        maxConnections: Int = 32,
        maxPerIp: Int = 4,
        deadline: Long = 3_000,
        allowed: (InetAddress) -> Boolean = { true },
    ) = LanHttpServer(processor(handler), 0, InetAddress.getLoopbackAddress(), maxConnections, maxPerIp, deadline, allowed)

    private fun client() = LanClient(LanHttpClient(), clock) { config(deviceId = "c", lanSecret = secret) }

    @Test
    fun `sources outside the venue network are dropped before they take a slot`() {
        val s = server(allowed = { false })
        val port = s.start()
        try {
            Socket("127.0.0.1", port).use {
                it.soTimeout = 2_000
                assertEquals(-1, it.getInputStream().read()) // closed at once, no answer
            }
            assertEquals(0, s.activeConnections)
        } finally {
            s.stop()
        }
    }

    @Test
    fun `at most maxPerIp connections per source address`() {
        val s = server(maxPerIp = 2, deadline = 5_000)
        val port = s.start()
        val held = ArrayList<Socket>()
        try {
            repeat(2) { held += Socket("127.0.0.1", port) } // idle peers keep their slots
            assertTrue(waitUntil { s.activeConnections == 2 })
            Socket("127.0.0.1", port).use {
                it.soTimeout = 2_000
                assertEquals(-1, it.getInputStream().read(), "the third connection of the address is refused")
            }
            assertEquals(2, s.activeConnections)
        } finally {
            held.forEach { runCatching { it.close() } }
            s.stop()
        }
        assertTrue(waitUntil { s.activeConnections == 0 })
    }

    @Test
    fun `ipv6 peers are limited per 64 prefix, ipv4 per address`() {
        fun v6(last: Int) = Inet6Address.getByAddress(null, ByteArray(16).also { it[0] = 0xfd.toByte(); it[7] = 1; it[15] = last.toByte() }, null)
        assertEquals(LanSourcePolicy.sourceKey(v6(1)), LanSourcePolicy.sourceKey(v6(2)))
        assertFalse(LanSourcePolicy.sourceKey(v6(1)) == LanSourcePolicy.sourceKey(InetAddress.getByName("fd00::1")))
        assertEquals("192.168.1.5", LanSourcePolicy.sourceKey(InetAddress.getByName("192.168.1.5")))
    }

    @Test
    fun `reserved slots are only for sources that authenticated before`() = runBlocking {
        val s = LanHttpServer(processor(ThrowingHandler()), 0, InetAddress.getLoopbackAddress(), 3, 8, 5_000, { true }, 1)
        val port = s.start()
        val held = ArrayList<Socket>()
        try {
            // Unauthenticated: only the 2 general slots are available, the third is refused.
            repeat(2) { held += Socket("127.0.0.1", port) }
            assertTrue(waitUntil { s.activeConnections == 2 })
            Socket("127.0.0.1", port).use { it.soTimeout = 2_000; assertEquals(-1, it.getInputStream().read()) }
            held.forEach { it.close() }
            held.clear()
            assertTrue(waitUntil { s.activeConnections == 0 })
            // Authenticate once, then fill the general slots: the trusted source still gets the reserved slot.
            assertEquals("master", client().hello(LanEndpoint("127.0.0.1", port), EVENT_A, "c").deviceId)
            repeat(2) { held += Socket("127.0.0.1", port) }
            assertTrue(waitUntil { s.activeConnections == 2 })
            assertEquals("master", client().hello(LanEndpoint("127.0.0.1", port), EVENT_A, "c").deviceId)
        } finally {
            held.forEach { runCatching { it.close() } }
            s.stop()
        }
    }

    @Test
    fun `a peer that sends nothing is cut off at the deadline and its slot is freed`() {
        val s = server(deadline = 400)
        val port = s.start()
        try {
            Socket("127.0.0.1", port).use {
                it.soTimeout = 3_000
                it.getOutputStream().apply { write("POST /lan/v1/hello HTTP/1.1\r\n".toByteArray()); flush() }
                val t0 = System.nanoTime()
                assertEquals(-1, runCatching { it.getInputStream().read() }.getOrDefault(-1))
                assertTrue((System.nanoTime() - t0) / 1_000_000 < 2_500)
            }
            assertTrue(waitUntil { s.activeConnections == 0 })
        } finally {
            s.stop()
        }
    }

    @Test
    fun `a trickling sender cannot outlive the overall deadline`() {
        val s = server(deadline = 600)
        val port = s.start()
        try {
            Socket("127.0.0.1", port).use { sock ->
                sock.soTimeout = 4_000
                val out = sock.getOutputStream()
                val t0 = System.nanoTime()
                // One header byte every 100 ms: every single read would succeed within the per-read timeout.
                val feeder = thread(isDaemon = true) {
                    try {
                        out.write("POST /x HTTP/1.1\r\nX-A: ".toByteArray())
                        while (true) { out.write('a'.code); out.flush(); Thread.sleep(100) }
                    } catch (_: IOException) {
                        // closed by the server
                    }
                }
                assertEquals(-1, runCatching { sock.getInputStream().read() }.getOrDefault(-1))
                assertTrue((System.nanoTime() - t0) / 1_000_000 < 3_000, "closed by the deadline timer")
                feeder.join(2_000)
            }
        } finally {
            s.stop()
        }
    }

    @Test
    fun `a handler error never leaks the connection slot`() = runBlocking {
        val handler = ThrowingHandler(Error("boom"))
        val s = server(handler, maxConnections = 1, maxPerIp = 1)
        val port = s.start()
        try {
            val ep = LanEndpoint("127.0.0.1", port)
            repeat(3) {
                assertFailsWith<LanProtocolException> { client().hello(ep, EVENT_A, "c") } // answered 500, slot back
            }
            handler.error = null
            assertEquals("master", client().hello(ep, EVENT_A, "c").deviceId)
            assertTrue(waitUntil { s.activeConnections == 0 })
        } finally {
            s.stop()
        }
    }

    @Test
    fun `body buffers grow with the bytes that arrive, a huge announcement costs nothing`() {
        val announced = 1_000_000_000
        assertFailsWith<IOException> { readBody(ByteArrayInputStream(ByteArray(10)), announced) }
        val data = ByteArray(300_000) { it.toByte() }
        assertTrue(readBody(ByteArrayInputStream(data), data.size).contentEquals(data))
        // A reader that returns one byte at a time still yields the exact body.
        val trickle = object : InputStream() {
            var i = 0
            override fun read() = if (i < 5) i++ else -1
            override fun read(b: ByteArray, off: Int, len: Int): Int = if (i >= 5) -1 else { b[off] = (i++).toByte(); 1 }
        }
        assertEquals(listOf<Byte>(0, 1, 2, 3, 4), readBody(trickle, 5).toList())
    }

    @Test
    fun `an unparsable or chunked request is refused`() {
        val s = server()
        val port = s.start()
        try {
            fun send(raw: String): String = Socket("127.0.0.1", port).use {
                it.soTimeout = 2_000
                it.getOutputStream().apply { write(raw.toByteArray()); flush() }
                it.getInputStream().readBytes().toString(Charsets.ISO_8859_1)
            }
            assertTrue(send("POST /x HTTP/1.1\r\nContent-Length: abc\r\n\r\n").startsWith("HTTP/1.1 400"))
            assertTrue(send("POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").startsWith("HTTP/1.1 400"))
            assertTrue(send("POST /x HTTP/1.1\r\nContent-Length: 2000000\r\n\r\n").startsWith("HTTP/1.1 413"))
        } finally {
            s.stop()
        }
    }

    @Test
    fun `a client deadline holds against a peer that trickles its answer`() = runBlocking {
        val peer = ServerSocket(0, 5, InetAddress.getLoopbackAddress())
        val feeder = thread(isDaemon = true) {
            try {
                peer.accept().use { c ->
                    val out = c.getOutputStream()
                    out.write("HTTP/1.1 200 OK\r\nX-A: ".toByteArray())
                    while (true) { out.write('a'.code); out.flush(); Thread.sleep(50) }
                }
            } catch (_: IOException) {
                // the client closed its side
            }
        }
        try {
            val t0 = System.nanoTime()
            val e = runCatching {
                LanHttpClient().post("127.0.0.1", peer.localPort, "/x", emptyMap(), ByteArray(3), timeoutMillis = 500)
            }.exceptionOrNull()
            assertTrue(e is LanNetworkException, "was $e")
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 2_500)
        } finally {
            peer.close()
            feeder.join(2_000)
        }
    }

    @Test
    fun `the server restarts after its listener broke`() {
        val s = server()
        val first = s.start()
        assertTrue(s.isRunning)
        s.stop()
        assertFalse(s.isRunning)
        val second = s.start()
        try {
            assertTrue(s.isRunning)
            assertEquals("master", runBlocking { client().hello(LanEndpoint("127.0.0.1", second), EVENT_A, "c").deviceId })
            assertTrue(first >= 0)
        } finally {
            s.stop()
        }
    }
}
