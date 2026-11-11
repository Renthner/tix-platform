package org.tix.checkin.core.lan

import java.net.InetAddress
import java.net.Socket
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.ScannerJson
import org.tix.checkin.core.contract.ScanTicketDisplay
import org.tix.checkin.core.scan.EVENT_A
import org.tix.checkin.core.scan.FakeDb
import org.tix.checkin.core.scan.ScanCommand
import org.tix.checkin.core.scan.TestKeys
import org.tix.checkin.core.scan.config
import org.tix.checkin.core.scan.localTicket
import org.tix.checkin.core.scan.ticketId

class LanHttpTest {
    private val secret = ByteArray(32) { (it + 1).toByte() }
    private val clock = Clock { System.currentTimeMillis() }
    private val masterCfg = config(deviceName = "Master", deviceId = "master", lanSecret = secret)
    private val db = FakeDb().also { it.tickets[ticketId(1)] = localTicket(1) }
    private val processor = LanRequestProcessor(
        { "master" }, { masterCfg.events[it]?.lanSecret }, clock,
        LanMasterHandler({ masterCfg }, db, Mutex(), clock, LanPeers()) { "master" },
    )
    private val server = LanHttpServer(processor, 0, InetAddress.getLoopbackAddress())

    @Test
    fun `scan over real sockets, tampering and garbage`() = runBlocking {
        val port = server.start()
        try {
            val cfg = config(deviceName = "Door A", deviceId = "a", lanSecret = secret)
            val client = LanClient(LanHttpClient(), clock) { cfg }
            val ep = LanEndpoint("127.0.0.1", port)
            assertEquals("Master", client.hello(ep, EVENT_A, "Door A").deviceName)

            val cmd = ScanCommand("s1", EVENT_A, ScanAction.CHECK_IN, ScanSource.CAMERA, payload = TestKeys.payload(ticketId(1)), scannedAtMillis = clock.nowMillis())
            val r = client.scan(ep, EVENT_A, LanScanRequest(cmd.toRequest(), "Door A"))
            assertEquals(ScanResult.ACCEPTED, r.result)
            assertEquals(CheckInState.CHECKED_IN, db.tickets.getValue(ticketId(1)).checkInState)
            val again = client.scan(ep, EVENT_A, LanScanRequest(cmd.copy(clientScanId = "s2").toRequest(), "Door A"))
            assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, again.result)

            // A client with another secret is refused (key mismatch is signalled).
            val other = LanClient(LanHttpClient(), clock) { config(deviceId = "x", lanSecret = ByteArray(32) { 9 }) }
            assertTrue(runCatching { other.hello(ep, EVENT_A, "x") }.exceptionOrNull() is LanKeyMismatchException)

            // Raw garbage and a truncated body must not kill the server.
            Socket("127.0.0.1", port).use { it.getOutputStream().apply { write("GARBAGE\r\n\r\n".toByteArray()); flush() } }
            Socket("127.0.0.1", port).use {
                it.getOutputStream().apply { write("POST /lan/v1/scan HTTP/1.1\r\nContent-Length: 5000000\r\n\r\n".toByteArray()); flush() }
                assertTrue(it.getInputStream().readBytes().toString(Charsets.ISO_8859_1).startsWith("HTTP/1.1 413"))
            }
            assertEquals("Master", client.hello(ep, EVENT_A, "Door A").deviceName)
        } finally {
            server.stop()
        }
    }

    @Test
    fun `unreachable master fails fast`() = runBlocking {
        val cfg = config(deviceId = "a", lanSecret = secret)
        val client = LanClient(LanHttpClient(), clock) { cfg }
        val started = System.nanoTime()
        val ex = runCatching { client.hello(LanEndpoint("127.0.0.1", 1), EVENT_A, "a", timeoutMillis = 300) }.exceptionOrNull()
        assertTrue(ex is LanNetworkException)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000)
    }
}

class LanProtocolTest {
    @Test
    fun `dtos round trip through the shared json`() {
        val state = LanTicketState(
            ticketId = "t", eventId = "e", checkInState = CheckInState.CHECKED_IN, lastScanAt = "2026-01-01T10:00:00.000Z",
            display = ScanTicketDisplay(id = "t", attendeeName = "A"),
        )
        val resp = LanScanResponse("c1", ScanResult.ACCEPTED, state = state)
        val back = ScannerJson.decodeFromString<LanScanResponse>(ScannerJson.encodeToString(resp))
        assertEquals(resp, back)
        assertNull(back.notice)
        // Unknown fields and unknown enum values of a newer master do not break an older client.
        val future = """{"clientScanId":"c","result":"SOMETHING_NEW","extra":1}"""
        assertEquals(ScanResult.UNKNOWN, ScannerJson.decodeFromString<LanScanResponse>(future).result)
        val sync = ScannerJson.decodeFromString<LanSyncResponse>("""{"changes":[],"nextCursor":4,"hasMore":true,"maxCursor":9}""")
        assertEquals(4, sync.nextCursor)
    }

    @Test
    fun `advert attributes carry hashes only and match by hash`() {
        val ad = LanAdvert("dev", "Master", listOf(LanAdvert.eventHash("e1"), LanAdvert.eventHash("e2")))
        val attrs = ad.toAttributes()
        assertTrue(attrs.values.none { it.contains("e1") })
        assertTrue(attrs.values.all { it.length <= 255 })
        val parsed = LanAdvert.parse(attrs)
        assertNotNull(parsed)
        assertTrue(parsed.servesAny(listOf("zz", "e2")))
        assertTrue(!parsed.servesAny(listOf("zz")))
        assertNull(LanAdvert.parse(attrs + ("v" to "2")))
    }
}
