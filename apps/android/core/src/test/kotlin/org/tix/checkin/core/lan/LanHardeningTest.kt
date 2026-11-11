package org.tix.checkin.core.lan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanRequest
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.scan.ConfigSnapshot
import org.tix.checkin.core.scan.EVENT_A
import org.tix.checkin.core.scan.EVENT_B
import org.tix.checkin.core.scan.EventConfig
import org.tix.checkin.core.scan.FakeDb
import org.tix.checkin.core.scan.LocalScanAuthority
import org.tix.checkin.core.scan.ScanCommand
import org.tix.checkin.core.scan.TestKeys
import org.tix.checkin.core.scan.config
import org.tix.checkin.core.scan.localTicket
import org.tix.checkin.core.scan.syncTicket
import org.tix.checkin.core.scan.ticketId

private val SECRET_A = ByteArray(32) { (it + 1).toByte() }
private val SECRET_B = ByteArray(32) { (it + 50).toByte() }
private val realClock = Clock { System.currentTimeMillis() }

/** Delivers a request straight to a processor (no sockets); a null processor behaves like an unreachable master. */
private class RoutingWire(private val processors: MutableMap<String, LanRequestProcessor> = HashMap()) : LanWire {
    fun put(host: String, p: LanRequestProcessor) { processors[host] = p }
    fun drop(host: String) { processors.remove(host) }

    override suspend fun post(host: String, port: Int, path: String, headers: Map<String, String>, body: ByteArray, timeoutMillis: Long): WireResponse {
        val p = processors[host] ?: throw LanNetworkException("down")
        return p.process("POST", path, headers, body)
    }
}

private class MasterNode(val id: String, val name: String, secret: ByteArray = SECRET_A, store: LanMasterStore? = null, clock: Clock = realClock) {
    val db = FakeDb()
    val cfg: ConfigSnapshot = config(deviceName = name, deviceId = id, lanSecret = secret)
    val peers = LanPeers()
    val processor = LanRequestProcessor(
        { id }, { cfg.events[it]?.lanSecret }, clock,
        LanMasterHandler({ cfg }, store ?: db, Mutex(), clock, peers) { id },
    )
}

private class ClientNode(val id: String, val name: String, val wire: LanWire, secret: ByteArray = SECRET_A, clock: Clock = realClock) {
    val db = FakeDb()
    val cfg: ConfigSnapshot = config(deviceName = name, deviceId = id, lanSecret = secret)
    val client = LanClient(wire, clock) { cfg }
    val link = LanMasterLink()
    var candidates: List<LanEndpoint> = emptyList()
    val manager = LanClientManager(client, link, { cfg }, { candidates }, db)
    val local = LocalScanAuthority({ cfg }, db)

    /** A scan decided on this device alone: a LOCAL journal row (the master is told later). */
    fun localScan(n: Int, id: String, at: Long = System.currentTimeMillis() - 20_000) = runBlocking {
        local.scan(
            ScanCommand(id, EVENT_A, ScanAction.CHECK_IN, ScanSource.CAMERA, payload = TestKeys.payload(ticketId(n)), scannedAtMillis = at),
        )
    }
}

private fun scanReq(id: String, n: Int, eventId: String = EVENT_A, payloadEvent: String = eventId) = ScanRequest(
    clientScanId = id, eventId = eventId, action = ScanAction.CHECK_IN, source = ScanSource.CAMERA,
    payload = TestKeys.payload(ticketId(n), payloadEvent), scannedAt = Iso.format(System.currentTimeMillis()),
)

private fun twoEventConfig(name: String, id: String): ConfigSnapshot {
    val base = config(deviceName = name, deviceId = id, lanSecret = SECRET_A)
    val a = base.events.getValue(EVENT_A)
    val b = EventConfig(
        id = EVENT_B, title = "Evening", entranceId = null, allowCheckOut = true, keys = a.keys,
        ticketTypes = a.ticketTypes, sectionEntrances = a.sectionEntrances, lanSecret = SECRET_B,
    )
    return ConfigSnapshot(true, name, mapOf(EVENT_A to a, EVENT_B to b), id)
}

class LanMasterEventBindingTest {
    private val masterCfg = twoEventConfig("Master", "master")
    private val db = FakeDb().also {
        it.tickets[ticketId(1)] = localTicket(1, eventId = EVENT_A) // matinee
        it.tickets[ticketId(2)] = localTicket(2, eventId = EVENT_B) // evening
    }
    private val processor = LanRequestProcessor(
        { "master" }, { masterCfg.events[it]?.lanSecret }, realClock,
        LanMasterHandler({ masterCfg }, db, Mutex(), realClock, LanPeers()) { "master" },
    )
    private val clientCfg = twoEventConfig("Door", "d1")
    private val client = LanClient(RoutingWire().also { it.put("m", processor) }, realClock) { clientCfg }
    private val ep = LanEndpoint("m", 1)

    @Test
    fun `matinee ticket sent under the evening envelope is RED wrong event and changes nothing`() = runBlocking {
        val r = client.scan(ep, EVENT_B, LanScanRequest(scanReq("c1", 1, eventId = EVENT_B, payloadEvent = EVENT_A), "Door"))
        assertEquals(ScanResult.REJECTED_WRONG_EVENT, r.result)
        assertNull(r.notice, "a RED answer, not 'no decision' (the client would fall back to a local decision)")
        assertNull(r.state)
        assertEquals(CheckInState.NONE, db.tickets.getValue(ticketId(1)).checkInState)
        assertEquals(0L, db.lanSeq)
        // The right event still works.
        assertEquals(ScanResult.ACCEPTED, client.scan(ep, EVENT_A, LanScanRequest(scanReq("c2", 1), "Door")).result)
    }

    @Test
    fun `a manual scan of another event's ticket under the envelope is RED wrong event`() = runBlocking {
        val manual = ScanRequest(
            clientScanId = "m1", eventId = EVENT_B, action = ScanAction.CHECK_IN, source = ScanSource.MANUAL,
            ticketId = ticketId(1), scannedAt = Iso.format(System.currentTimeMillis()),
        )
        val r = client.scan(ep, EVENT_B, LanScanRequest(manual, "Door"))
        assertEquals(ScanResult.REJECTED_WRONG_EVENT, r.result)
        assertEquals(CheckInState.NONE, db.tickets.getValue(ticketId(1)).checkInState)
    }

    @Test
    fun `a valid signature of the envelope's event never replaces a row of another event`() = runBlocking {
        // Ticket id 1 exists under the matinee; a (valid) evening signature for the same id must not turn it provisional.
        val r = client.scan(ep, EVENT_B, LanScanRequest(scanReq("c3", 1, eventId = EVENT_B), "Door"))
        assertEquals(ScanResult.REJECTED_WRONG_EVENT, r.result)
        val row = db.tickets.getValue(ticketId(1))
        assertEquals(EVENT_A, row.eventId)
        assertFalse(row.provisional)
        // The same through the reconnect push: the row of the other event is left alone.
        val pushed = client.push(
            ep, EVENT_B,
            LanPushRequest("Door", listOf(LanReportedScan(scanReq("c4", 1, eventId = EVENT_B), ScanResult.ACCEPTED))),
        )
        assertFalse(pushed.results.single().applied)
        assertEquals(EVENT_A, db.tickets.getValue(ticketId(1)).eventId)
    }
}

class LanSessionKeysTest {
    @Test
    fun `two devices may use the same client scan id for different tickets`() = runBlocking {
        val master = MasterNode("master", "Master")
        master.db.tickets[ticketId(1)] = localTicket(1)
        master.db.tickets[ticketId(2)] = localTicket(2)
        val wire = RoutingWire().also { it.put("m", master.processor) }
        val a = ClientNode("a", "Door A", wire)
        val b = ClientNode("b", "Door B", wire)
        val ep = LanEndpoint("m", 1)
        val ra = a.client.scan(ep, EVENT_A, LanScanRequest(scanReq("same-id", 1), "Door A"))
        val rb = b.client.scan(ep, EVENT_A, LanScanRequest(scanReq("same-id", 2), "Door B"))
        assertEquals(ticketId(1), ra.state?.ticketId)
        assertEquals(ticketId(2), rb.state?.ticketId, "must not receive door A's cached answer")
        assertEquals(CheckInState.CHECKED_IN, master.db.tickets.getValue(ticketId(2)).checkInState)
        // The push dedupe is per device as well.
        master.db.tickets[ticketId(3)] = localTicket(3)
        master.db.tickets[ticketId(4)] = localTicket(4)
        val pa = a.client.push(ep, EVENT_A, LanPushRequest("Door A", listOf(LanReportedScan(scanReq("p", 3), ScanResult.ACCEPTED))))
        val pb = b.client.push(ep, EVENT_A, LanPushRequest("Door B", listOf(LanReportedScan(scanReq("p", 4), ScanResult.ACCEPTED))))
        assertTrue(pa.results.single().applied)
        assertTrue(pb.results.single().applied)
    }

    /** A store whose first commitLan fails (disk full, locked database). */
    private class FlakyStore(val db: FakeDb) : LanMasterStore by db {
        var failures = 1
        override suspend fun commitLan(ticket: org.tix.checkin.core.scan.LocalTicket) {
            if (failures-- > 0) throw IllegalStateException("disk full")
            db.commitLan(ticket)
        }
    }

    @Test
    fun `a pushed scan is marked as done only after its commit succeeded`() = runBlocking {
        val db = FakeDb().also { it.tickets[ticketId(1)] = localTicket(1) }
        val master = MasterNode("master", "Master", store = FlakyStore(db))
        val wire = RoutingWire().also { it.put("m", master.processor) }
        val a = ClientNode("a", "Door A", wire)
        val ep = LanEndpoint("m", 1)
        val req = LanPushRequest("Door A", listOf(LanReportedScan(scanReq("p1", 1), ScanResult.ACCEPTED)))
        assertFailsWith<LanProtocolException> { a.client.push(ep, EVENT_A, req) } // 500: commit failed
        assertEquals(CheckInState.NONE, db.tickets.getValue(ticketId(1)).checkInState)
        // The retry is applied (a pre-marked id would have been skipped as a duplicate).
        assertTrue(a.client.push(ep, EVENT_A, req).results.single().applied)
        assertEquals(CheckInState.CHECKED_IN, db.tickets.getValue(ticketId(1)).checkInState)
    }

    @Test
    fun `the master logs which device asked for what`() = runBlocking {
        val master = MasterNode("master", "Master")
        val wire = RoutingWire().also { it.put("m", master.processor) }
        ClientNode("door-7", "Door", wire).client.hello(LanEndpoint("m", 1), EVENT_A, "Door")
        val log = master.peers.recentRequests()
        assertEquals(listOf("door-7"), log.map { it.deviceId })
        assertEquals(LanPaths.HELLO, log.single().path)
    }
}

class LanEpochTest {
    @Test
    fun `a master whose counter started over is detected by its epoch even when the cursor looks valid`() = runBlocking {
        val master = MasterNode("master", "Master")
        val wire = RoutingWire().also { it.put("m", master.processor) }
        val a = ClientNode("a", "Door A", wire)
        a.candidates = listOf(LanEndpoint("m", 1))
        for (n in 1..3) master.db.commitLan(localTicket(n).copy(checkInState = CheckInState.CHECKED_IN, checkInCount = 1, lastScanAt = Iso.format(1_800_000_000_000)))
        a.manager.tick(serverUsable = false)
        assertEquals(3L, a.db.cursor("master", EVENT_A))

        // The master's app data was wiped and it was paired again: new epoch, counter from 1 - beyond the client's cursor soon.
        master.db.tickets.clear()
        master.db.lanSeq = 0
        master.db.lanEpoch = "epoch-2"
        for (n in 11..15) master.db.commitLan(localTicket(n).copy(checkInState = CheckInState.CHECKED_IN, checkInCount = 1, lastScanAt = Iso.format(1_800_000_000_000)))
        a.manager.tick(serverUsable = false)
        // Without the epoch the cursor 3 would hide the positions 1..3 of the new feed.
        for (n in 11..15) assertEquals(CheckInState.CHECKED_IN, a.db.tickets.getValue(ticketId(n)).checkInState)
        assertEquals(5L, a.db.cursor("master", EVENT_A))
    }
}

class LanMasterSelectionTest {
    private fun hello(id: String) = LanHello(deviceId = id, deviceName = id)

    @Test
    fun `picker prefers the last working master, otherwise the lowest device id`() {
        val valid = listOf("e-c" to hello("ccc"), "e-b" to hello("bbb"), "e-a" to hello("aaa"))
        assertEquals("e-a", LanMasterPicker.choose(valid, null)?.first)
        assertEquals("e-b", LanMasterPicker.choose(valid, "bbb")?.first)
        assertEquals("e-a", LanMasterPicker.choose(valid, "gone")?.first)
        assertNull(LanMasterPicker.choose(emptyList<Pair<String, LanHello>>(), "x"))
    }

    @Test
    fun `a client sees a duplicate only while two distinct masters advertise its event`() {
        val h = listOf(LanAdvert.eventHash(EVENT_A))
        val one = listOf(LanAdvert("aaa", "A", h))
        val two = one + LanAdvert("bbb", "B", h)
        assertFalse(LanMasterPicker.duplicates(one, listOf(EVENT_A)))
        assertTrue(LanMasterPicker.duplicates(two, listOf(EVENT_A)))
        assertFalse(LanMasterPicker.duplicates(one, listOf(EVENT_A)), "goes back to false when the second master is gone")
        assertFalse(LanMasterPicker.duplicates(two, listOf(EVENT_B)), "another event is no conflict")
        assertFalse(LanMasterPicker.duplicates(listOf(one[0], one[0].copy(name = "renamed")), listOf(EVENT_A)), "the same device twice")
    }

    @Test
    fun `adverts of other masters serving my events are conflicts`() {
        val mine = listOf(EVENT_A)
        val adverts = listOf(
            LanAdvert("self", "Me", listOf(LanAdvert.eventHash(EVENT_A))),
            LanAdvert("other", "Other", listOf(LanAdvert.eventHash(EVENT_A))),
            LanAdvert("elsewhere", "Else", listOf(LanAdvert.eventHash(EVENT_B))),
        )
        assertEquals(listOf("other"), LanMasterPicker.conflicting("self", adverts, mine).map { it.deviceId })
    }

    @Test
    fun `a client picks the lowest id of two masters, flags the duplicate and sticks to its master`() = runBlocking {
        val mA = MasterNode("aaa", "Master A")
        val mB = MasterNode("bbb", "Master B")
        val wire = RoutingWire().also { it.put("ha", mA.processor); it.put("hb", mB.processor) }
        val c = ClientNode("c", "Door", wire)
        c.candidates = listOf(LanEndpoint("hb", 1, "bbb"), LanEndpoint("ha", 1, "aaa")) // advertised order must not matter
        c.manager.tick(serverUsable = false)
        assertEquals("aaa", c.link.master?.deviceId)
        assertTrue(c.manager.duplicateMasters)
        // Master A disappears: B takes over; A coming back does not make the client flap.
        wire.drop("ha")
        c.link.setMaster(null)
        c.manager.tick(false)
        assertEquals("bbb", c.link.master?.deviceId)
        wire.put("ha", mA.processor)
        c.manager.tick(false)
        assertEquals("bbb", c.link.master?.deviceId)
        // After a disconnect the last successful master is preferred over the lower id.
        c.link.setMaster(null)
        c.manager.tick(false)
        assertEquals("bbb", c.link.master?.deviceId)
    }

    @Test
    fun `every candidate is tried, not just the first five`() = runBlocking {
        val master = MasterNode("m-real", "Real")
        val wire = RoutingWire().also { it.put("real", master.processor) }
        val c = ClientNode("c", "Door", wire)
        c.candidates = (1..9).map { LanEndpoint("dead$it", 1) } + LanEndpoint("real", 1)
        c.manager.tick(false)
        assertEquals("m-real", c.link.master?.deviceId)
    }

    @Test
    fun `an answer from another device than the advertised one is not a valid hello`() = runBlocking {
        val master = MasterNode("master", "Master")
        val wire = RoutingWire().also { it.put("m", master.processor) }
        val c = ClientNode("c", "Door", wire)
        assertFailsWith<LanProtocolException> { c.client.hello(LanEndpoint("m", 1, deviceId = "somebody-else"), EVENT_A, "Door") }
        assertEquals("master", c.client.hello(LanEndpoint("m", 1, deviceId = "master"), EVENT_A, "Door").deviceId)
        // And through the manager an impostor behind a master's address is simply not a candidate.
        c.candidates = listOf(LanEndpoint("m", 1, deviceId = "somebody-else"))
        c.manager.tick(false)
        assertNull(c.link.master)
        assertEquals(LanHealth.NO_MASTER, c.manager.health)
    }
}

class LanClockTest {
    @Test
    fun `a clock that differs by more than a minute is reported as clock skew`() = runBlocking {
        val master = MasterNode("master", "Master")
        val wire = RoutingWire().also { it.put("m", master.processor) }
        val skewed = Clock { System.currentTimeMillis() + 5 * 60_000 }
        val c = ClientNode("c", "Door", wire, clock = skewed)
        assertFailsWith<LanClockException> { c.client.hello(LanEndpoint("m", 1), EVENT_A, "Door") }
        c.candidates = listOf(LanEndpoint("m", 1))
        c.manager.tick(false)
        assertEquals(LanHealth.CLOCK_SKEW, c.manager.health)
        assertNull(c.link.master)
    }
}

class LanPushWatermarkTest {
    @Test
    fun `a new master gets every scan it has not acknowledged, per master and event`() = runBlocking {
        val m1 = MasterNode("m1", "Master 1")
        val m2 = MasterNode("m2", "Master 2")
        for (n in 1..2) { m1.db.tickets[ticketId(n)] = localTicket(n); m2.db.tickets[ticketId(n)] = localTicket(n) }
        val wire = RoutingWire().also { it.put("h1", m1.processor); it.put("h2", m2.processor) }
        val c = ClientNode("c", "Door", wire)
        for (n in 1..2) c.db.tickets[ticketId(n)] = localTicket(n)
        c.localScan(1, "s1")
        c.localScan(2, "s2", at = System.currentTimeMillis() - 30_000) // an OLDER timestamp than s1, later journal row

        c.candidates = listOf(LanEndpoint("h1", 1))
        c.manager.tick(false)
        assertEquals(CheckInState.CHECKED_IN, m1.db.tickets.getValue(ticketId(1)).checkInState)
        assertEquals(CheckInState.CHECKED_IN, m1.db.tickets.getValue(ticketId(2)).checkInState, "scan time order must not hide a row")
        assertEquals(CheckInState.NONE, m2.db.tickets.getValue(ticketId(1)).checkInState)

        // Master 1 is replaced by master 2: everything is reported again, to the new master.
        c.link.setMaster(null)
        c.candidates = listOf(LanEndpoint("h2", 1))
        c.manager.tick(false)
        assertEquals(CheckInState.CHECKED_IN, m2.db.tickets.getValue(ticketId(1)).checkInState)
        assertEquals(CheckInState.CHECKED_IN, m2.db.tickets.getValue(ticketId(2)).checkInState)
        // Acknowledged scans are not sent again.
        val before = m2.db.lanSeq
        c.manager.tick(false)
        assertEquals(before, m2.db.lanSeq)
    }
}

class LanClientDeadlineTest {
    private class HangingWire : LanWire {
        override suspend fun post(host: String, port: Int, path: String, headers: Map<String, String>, body: ByteArray, timeoutMillis: Long): WireResponse {
            delay(60_000)
            throw AssertionError("unreachable")
        }
    }

    @Test
    fun `a peer that never answers ends in a LanNetworkException at the deadline, not a cancellation`() = runBlocking {
        val cfg = config(deviceName = "Door", deviceId = "d", lanSecret = SECRET_A)
        val client = LanClient(HangingWire(), realClock) { cfg }
        val t0 = System.nanoTime()
        val e = runCatching { client.hello(LanEndpoint("m", 1), EVENT_A, "Door", timeoutMillis = 300) }.exceptionOrNull()
        assertTrue(e is LanNetworkException, "was $e")
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 3_000)
    }
}

class LanAdvertTrackerTest {
    @Test
    fun `the advert is registered again when the served events or the device name change`() {
        val t = LanAdvertTracker()
        val a1 = LanAdvert("id", "Master", listOf(LanAdvert.eventHash(EVENT_A)))
        assertTrue(t.needsRegister(a1))
        t.markRegistered(a1)
        assertFalse(t.needsRegister(a1.copy()))
        assertTrue(t.needsRegister(a1.copy(eventHashes = listOf(LanAdvert.eventHash(EVENT_A), LanAdvert.eventHash(EVENT_B)))))
        assertTrue(t.needsRegister(a1.copy(name = "Renamed")))
        t.clear()
        assertTrue(t.needsRegister(a1))
    }
}

class LanEndpointParseTest {
    @Test
    fun `manual addresses incl ipv6 literals in brackets`() {
        assertEquals(LanEndpoint("192.168.1.20", 47800), LanEndpoint.parseManual("192.168.1.20"))
        assertEquals(LanEndpoint("192.168.1.20", 5000), LanEndpoint.parseManual(" 192.168.1.20:5000 "))
        assertEquals(LanEndpoint("master.local", 47800), LanEndpoint.parseManual("master.local"))
        assertEquals(LanEndpoint("fe80::1", 47800), LanEndpoint.parseManual("[fe80::1]"))
        assertEquals(LanEndpoint("fe80::1", 5000), LanEndpoint.parseManual("[fe80::1]:5000"))
        assertEquals(LanEndpoint("fd00::2", 47800), LanEndpoint.parseManual("fd00::2"))
        assertNull(LanEndpoint.parseManual(""))
        assertNull(LanEndpoint.parseManual("[fe80::1"))
        assertNull(LanEndpoint.parseManual("[fe80::1]x"))
        assertNull(LanEndpoint.parseManual("host:99999"))
        assertNull(LanEndpoint.parseManual("host:abc"))
        assertNull(LanEndpoint.parseManual("user@host"))
    }

    @Test
    fun `an ipv6 endpoint passes the local network policy only with brackets`() {
        val ep = LanEndpoint("fe80::1", 47800)
        assertEquals("[fe80::1]:47800", ep.authority)
        assertTrue(org.tix.checkin.core.ServerUrlPolicy.isAllowed(ep.policyUrl))
        assertFalse(org.tix.checkin.core.ServerUrlPolicy.isAllowed(LanEndpoint("2001:db8::1", 1).policyUrl))
        assertNotNull(LanEndpoint.parseManual("[fe80::1]:1")?.policyUrl)
    }
}

class LanFeedTest {
    @Test
    fun `server rows hold the same feed position rules as scans`() {
        // A cancellation learned from the server must reach the LAN feed (rows with no relevant change do not).
        val db = FakeDb()
        db.tickets[ticketId(1)] = localTicket(1)
        db.tickets[ticketId(2)] = localTicket(2)
        runBlocking {
            db.applyPage(
                EVENT_A,
                org.tix.checkin.core.contract.SyncPage(
                    listOf(
                        syncTicket(1, 10, status = TicketStatus.CANCELLED),
                        syncTicket(2, 10),
                        syncTicket(3, 10, state = CheckInState.CHECKED_IN),
                    ),
                    "c",
                ),
            )
        }
        val changed = runBlocking { db.changedSince(EVENT_A, 0, 100) }.map { it.id }
        assertEquals(listOf(ticketId(1), ticketId(3)), changed)
    }
}
