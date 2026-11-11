package org.tix.checkin.core.lan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanColor
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.scan.ConfigSnapshot
import org.tix.checkin.core.scan.DecidedBy
import org.tix.checkin.core.scan.ENTRANCE_N
import org.tix.checkin.core.scan.ENTRANCE_S
import org.tix.checkin.core.scan.EVENT_A
import org.tix.checkin.core.scan.FakeDb
import org.tix.checkin.core.scan.FallbackScanAuthority
import org.tix.checkin.core.scan.LocalScanAuthority
import org.tix.checkin.core.scan.Merge
import org.tix.checkin.core.scan.SECTION_N
import org.tix.checkin.core.scan.ScanAuthority
import org.tix.checkin.core.scan.ScanCommand
import org.tix.checkin.core.scan.ScanCoordinator
import org.tix.checkin.core.scan.ScanVerdict
import org.tix.checkin.core.scan.ServerLink
import org.tix.checkin.core.scan.TestKeys
import org.tix.checkin.core.scan.config
import org.tix.checkin.core.scan.localTicket
import org.tix.checkin.core.scan.syncTicket
import org.tix.checkin.core.scan.ticketId

private class TickClock(var t: Long = 1_800_000_000_000) : Clock {
    override fun nowMillis(): Long = t.also { t += 1000 }
}

/** A device in the venue: its own database, config and chain, wired to the master without sockets. */
private class Device(
    val name: String,
    val id: String,
    secret: ByteArray?,
    clock: Clock,
    master: Device?,
    entrance: String? = null,
    serverUp: Boolean = false,
    private val masterProcessor: (() -> LanRequestProcessor?)? = null,
    allowCheckOut: Boolean = true,
) {
    val db = FakeDb()
    val cfg: ConfigSnapshot = config(entrance = entrance, deviceName = name, deviceId = id, lanSecret = secret, allowCheckOut = allowCheckOut)
    val lock = Mutex()
    val peers = LanPeers()
    val local = LocalScanAuthority({ cfg }, db, lock)
    val link = LanMasterLink()
    val serverCalls = ArrayList<ScanCommand>()
    var serverAvailable = serverUp

    val processor = LanRequestProcessor(
        { id }, { cfg.events[it]?.lanSecret }, clock,
        LanMasterHandler({ cfg }, db, lock, clock, peers) { id },
    )

    inner class TestWire : LanWire {
        var up = true
        override suspend fun post(host: String, port: Int, path: String, headers: Map<String, String>, body: ByteArray, timeoutMillis: Long): WireResponse {
            if (!up) throw LanNetworkException("down")
            val p = masterProcessor?.invoke() ?: throw LanNetworkException("no master")
            return p.process("POST", path, headers, body)
        }
    }
    val wire = TestWire()
    val client = LanClient(wire, clock) { cfg }
    private val lanAuthority = LanMasterScanAuthority(client, link, { cfg }, db, lock)
    private val serverAuthority = object : ScanAuthority {
        override suspend fun scan(command: ScanCommand): ScanVerdict {
            serverCalls += command
            throw NetworkException("server down")
        }
    }
    private val serverLink = object : ServerLink {
        override fun isUsable() = serverAvailable
        override fun onSuccess() {}
        override fun onFailure(error: Throwable) {}
    }
    val chain = FallbackScanAuthority(serverAuthority, local, serverLink, db, lan = if (master != null) lanAuthority else null)
    val coordinator = ScanCoordinator(chain, { cfg }, clock)

    init {
        if (master != null) link.setMaster(LanEndpoint("master", 1, master.id, master.name))
    }

    fun scan(n: Int, action: ScanAction = ScanAction.CHECK_IN): ScanVerdict =
        runBlocking { coordinator.scanCode(TestKeys.payload(ticketId(n)), action, EVENT_A) }
}

private val SECRET = ByteArray(32) { (it * 3).toByte() }

class LanMasterTest {
    private val clock = TickClock()
    private val master = Device("Master", "master", SECRET, clock, null)
    private fun client(name: String, id: String, entrance: String? = null, secret: ByteArray? = SECRET, allowCheckOut: Boolean = true) =
        Device(name, id, secret, clock, master, entrance, masterProcessor = { master.processor }, allowCheckOut = allowCheckOut)

    private fun seed(n: Int, vararg dbs: FakeDb) = dbs.forEach { it.tickets[ticketId(n)] = localTicket(n) }

    @Test
    fun `two doors scanning the same ticket - one green one red with first scan info`() {
        val a = client("Door A", "a")
        val b = client("Door B", "b")
        seed(1, master.db, a.db, b.db)
        val first = a.scan(1)
        assertEquals(ScanResult.ACCEPTED, first.result)
        assertEquals(DecidedBy.LAN, first.decidedBy)
        val second = b.scan(1)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, second.result)
        assertEquals(ScanColor.RED, second.color)
        assertEquals("Door A", second.firstScan?.deviceName)
        // Both doors now know the ticket is inside; the master recorded the state without a journal row.
        assertEquals(CheckInState.CHECKED_IN, b.db.tickets.getValue(ticketId(1)).checkInState)
        assertEquals(CheckInState.CHECKED_IN, master.db.tickets.getValue(ticketId(1)).checkInState)
        assertTrue(master.db.journal.isEmpty())
        // Each device journals its own scan for its own upload.
        assertEquals(1, a.db.journal.size); assertFalse(a.db.journal.single().uploaded)
        assertEquals(DecidedBy.LAN, a.db.journal.single().decidedBy)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, b.db.journal.single().result)
        assertTrue(a.db.tickets.getValue(ticketId(1)).localDirty)
    }

    @Test
    fun `simultaneous scans of one ticket - exactly one is accepted`() = runBlocking {
        val doors = (1..8).map { client("Door $it", "d$it") }
        seed(1, master.db)
        val results = doors.map { d -> async { d.coordinator.scanCode(TestKeys.payload(ticketId(1)), ScanAction.CHECK_IN, EVENT_A) } }.awaitAll()
        assertEquals(1, results.count { it.result == ScanResult.ACCEPTED })
        assertEquals(7, results.count { it.result == ScanResult.REJECTED_ALREADY_CHECKED_IN })
    }

    @Test
    fun `master's own scans and LAN scans share one decision path`() = runBlocking {
        val door = client("Door A", "a")
        seed(1, master.db)
        // The master's own local scan and a client's LAN scan at the same time: one green, one red.
        val own = async { master.coordinator.scanCode(TestKeys.payload(ticketId(1)), ScanAction.CHECK_IN, EVENT_A) }
        val lan = async { door.coordinator.scanCode(TestKeys.payload(ticketId(1)), ScanAction.CHECK_IN, EVENT_A) }
        val both = listOf(own.await(), lan.await())
        assertEquals(1, both.count { it.result == ScanResult.ACCEPTED })
        assertEquals(1, both.count { it.result == ScanResult.REJECTED_ALREADY_CHECKED_IN })
    }

    @Test
    fun `the scanning device's entrance and name are used, not the master's`() {
        val door = client("Door S", "s", entrance = ENTRANCE_S)
        master.db.tickets[ticketId(1)] = localTicket(1, section = SECTION_N)
        door.db.tickets[ticketId(1)] = localTicket(1, section = SECTION_N)
        val v = door.scan(1)
        assertEquals(ScanResult.ACCEPTED_WITH_WARNING, v.result)
        assertTrue(ScanWarning.WRONG_ENTRANCE in v.warnings)
        assertEquals("Door S", master.db.tickets.getValue(ticketId(1)).firstCheckedInDeviceName)
        assertNotNull(ENTRANCE_N)
    }

    @Test
    fun `check-out permission of the client is respected without asking the master`() {
        val door = client("Door A", "a", allowCheckOut = false)
        seed(1, master.db, door.db)
        door.scan(1)
        val v = door.scan(1, ScanAction.CHECK_OUT)
        assertEquals(ScanResult.REJECTED_CHECK_OUT_NOT_ALLOWED, v.result)
        assertEquals(DecidedBy.LOCAL, v.decidedBy)
    }

    @Test
    fun `retry of the same scan id returns the same answer and changes nothing twice`() = runBlocking {
        val door = client("Door A", "a")
        seed(1, master.db, door.db)
        val cmd = ScanCommand("scan-1", EVENT_A, ScanAction.CHECK_IN, org.tix.checkin.core.contract.ScanSource.CAMERA, payload = TestKeys.payload(ticketId(1)), scannedAtMillis = clock.nowMillis())
        val req = LanScanRequest(cmd.toRequest(), "Door A")
        val r1 = door.client.scan(LanEndpoint("m", 1), EVENT_A, req)
        val r2 = door.client.scan(LanEndpoint("m", 1), EVENT_A, req)
        assertEquals(ScanResult.ACCEPTED, r1.result)
        assertEquals(ScanResult.ACCEPTED, r2.result)
        assertEquals(1, master.db.tickets.getValue(ticketId(1)).checkInCount)
    }

    @Test
    fun `unknown ticket with a valid signature is admitted by the master and visible to the other door`() {
        val a = client("Door A", "a")
        val b = client("Door B", "b")
        val v = a.scan(7)
        assertEquals(ScanResult.ACCEPTED, v.result)
        assertTrue(v.provisional)
        val w = b.scan(7)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, w.result)
    }

    @Test
    fun `server down and master up - master decides, both down - local decides`() {
        val door = client("Door A", "a")
        seed(1, master.db, door.db)
        seed(2, master.db, door.db)
        val viaMaster = door.scan(1)
        assertEquals(DecidedBy.LAN, viaMaster.decidedBy)
        door.wire.up = false
        val alone = door.scan(2)
        assertEquals(DecidedBy.LOCAL, alone.decidedBy)
        assertEquals(ScanResult.ACCEPTED, alone.result)
        // The master being unreachable is remembered: the next scan does not even try (no stall).
        assertNull(door.link.usable(EVENT_A))
    }

    @Test
    fun `server unusable never reaches the server, a server failure falls through to the master`() {
        val door = client("Door A", "a")
        seed(1, master.db, door.db)
        door.serverAvailable = true // server "usable" but failing
        val v = door.scan(1)
        assertEquals(1, door.serverCalls.size)
        assertEquals(DecidedBy.LAN, v.decidedBy)
    }

    @Test
    fun `own unsent check-in is red at once without asking the master`() {
        val door = client("Door A", "a")
        seed(1, master.db, door.db)
        door.wire.up = false
        assertEquals(ScanResult.ACCEPTED, door.scan(1).result) // decided alone
        door.wire.up = true
        door.link.setMaster(LanEndpoint("master", 1, "master", "Master"))
        val again = door.scan(1)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, again.result)
        assertEquals(DecidedBy.LOCAL, again.decidedBy)
        // The master never saw the first scan (nothing reported yet): it still thinks the guest is outside.
        assertEquals(CheckInState.NONE, master.db.tickets.getValue(ticketId(1)).checkInState)
    }

    @Test
    fun `a master that holds another key is reported as outdated key`() {
        val door = client("Door A", "a", secret = ByteArray(32) { 1 })
        seed(1, master.db, door.db)
        val v = door.scan(1)
        assertEquals(DecidedBy.LOCAL, v.decidedBy) // fell back
        assertTrue(door.link.keyOutdated)
        assertNull(door.link.usable(EVENT_A)) // this event is skipped for a while
    }

    @Test
    fun `reconnecting client reports its offline scans - stale rule and first entry`() = runBlocking {
        val a = client("Door A", "a")
        val b = client("Door B", "b")
        seed(1, master.db, a.db, b.db); seed(2, master.db, a.db, b.db); seed(3, master.db, a.db, b.db)
        val t0 = clock.t
        // Door B decided alone while the master was unreachable (earlier than anything at the master).
        b.wire.up = false
        val earlyIn = b.scan(1)
        val bOut2 = b.scan(2)
        b.wire.up = true
        // Meanwhile a LAN scan of ticket 1 happened later at door A: master state is CHECKED_IN by A.
        clock.t = t0 + 600_000
        a.scan(1)
        assertEquals("Door A", master.db.tickets.getValue(ticketId(1)).firstCheckedInDeviceName)
        assertEquals(ScanResult.ACCEPTED, earlyIn.result)

        val mgr = LanClientManager(b.client, b.link, { b.cfg }, { listOf(LanEndpoint("master", 1)) }, b.db) { clock.t }
        mgr.tick(serverUsable = false)
        assertEquals(LanHealth.CONNECTED, mgr.health)
        // Ticket 1: B's scan is OLDER than A's -> never changes the state, but B was first through the door.
        val m1 = master.db.tickets.getValue(ticketId(1))
        assertEquals(CheckInState.CHECKED_IN, m1.checkInState)
        assertEquals("Door B", m1.firstCheckedInDeviceName)
        assertEquals(1, m1.checkInCount)
        // Ticket 2: only B scanned: the master adopts it, door A learns it through the pull feed.
        assertEquals(CheckInState.CHECKED_IN, master.db.tickets.getValue(ticketId(2)).checkInState)
        val mgrA = LanClientManager(a.client, a.link, { a.cfg }, { listOf(LanEndpoint("master", 1)) }, a.db) { clock.t }
        mgrA.tick(serverUsable = false)
        assertEquals(CheckInState.CHECKED_IN, a.db.tickets.getValue(ticketId(2)).checkInState)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, a.scan(2).result)
        assertEquals(ScanResult.ACCEPTED, bOut2.result)
        // Reported scans are not reported twice.
        val before = master.db.lanSeq
        mgr.tick(serverUsable = false)
        assertEquals(before, master.db.lanSeq)
    }

    @Test
    fun `pull feed pages and resets a cursor that is ahead of the master`() = runBlocking {
        val a = client("Door A", "a")
        for (n in 1..5) { seed(n, master.db, a.db); master.scanLocalDirect(n) }
        val mgr = LanClientManager(a.client, a.link, { a.cfg }, { listOf(LanEndpoint("master", 1)) }, a.db) { clock.t }
        mgr.tick(serverUsable = false)
        for (n in 1..5) assertEquals(CheckInState.CHECKED_IN, a.db.tickets.getValue(ticketId(n)).checkInState)
        assertEquals(master.db.lanSeq, a.db.cursor("master", EVENT_A))
        // Master counter started over (new epoch): its feed starts at 0, the client's cursor is void -> reset to 0.
        master.db.lanSeq = 0
        master.db.lanEpoch = "epoch-2"
        master.db.tickets.replaceAll { _, t -> t.copy(lanSeq = 0) }
        a.db.setCursor("master", EVENT_A, 99)
        mgr.tick(serverUsable = false)
        assertEquals(0L, a.db.cursor("master", EVENT_A))
    }

    @Test
    fun `server serves delta while LAN state is held until the server caught up`() {
        val t = localTicket(1).copy(
            checkInState = CheckInState.CHECKED_IN, lastScanAt = Iso.format(1_800_000_010_000), lanDirty = true,
            firstCheckedInAt = Iso.format(1_800_000_010_000), checkInCount = 1,
        )
        // The server has not seen the scan yet: LAN state stays.
        val stale = Merge.mergeIncoming(t, syncTicket(1, 5))
        assertEquals(CheckInState.CHECKED_IN, stale.checkInState)
        assertTrue(stale.lanDirty)
        // The server's row reaches the scan time: take the server's state, release the hold.
        val caught = Merge.mergeIncoming(
            t, syncTicket(1, 6, state = CheckInState.CHECKED_OUT).copy(lastScanAt = Iso.format(1_800_000_020_000)),
        )
        assertEquals(CheckInState.CHECKED_OUT, caught.checkInState)
        assertFalse(caught.lanDirty)
        // A tombstone always wins.
        val void = Merge.mergeIncoming(t, syncTicket(1, 7, status = org.tix.checkin.core.contract.TicketStatus.CANCELLED))
        assertEquals(org.tix.checkin.core.contract.TicketStatus.CANCELLED, void.status)
    }

    @Test
    fun `reported scan merge rules`() {
        val base = localTicket(1)
        val t1 = 1_800_000_100_000
        val inAt = Merge.afterReportedScan(base, ScanAction.CHECK_IN, t1, "A")!!
        assertEquals(CheckInState.CHECKED_IN, inAt.checkInState)
        // second check-in (newer) while inside: no change
        assertNull(Merge.afterReportedScan(inAt, ScanAction.CHECK_IN, t1 + 5000, "B"))
        // stale check-out never changes the state
        assertNull(Merge.afterReportedScan(inAt, ScanAction.CHECK_OUT, t1 - 5000, "B"))
        // stale check-in older than the first entry moves the first-entry info only
        val moved = Merge.afterReportedScan(inAt, ScanAction.CHECK_IN, t1 - 5000, "B")!!
        assertEquals("B", moved.firstCheckedInDeviceName)
        assertEquals(inAt.lastScanAt, moved.lastScanAt)
        assertEquals(CheckInState.CHECKED_IN, moved.checkInState)
        // regular check-out after the last scan
        assertEquals(CheckInState.CHECKED_OUT, Merge.afterReportedScan(inAt, ScanAction.CHECK_OUT, t1 + 1000, "B")!!.checkInState)
        // void tickets are left alone
        assertNull(Merge.afterReportedScan(base.copy(status = org.tix.checkin.core.contract.TicketStatus.CANCELLED), ScanAction.CHECK_IN, t1, "A"))
    }

    @Test
    fun `peers are counted on the master`() {
        val a = client("Door A", "a")
        seed(1, master.db, a.db)
        a.scan(1)
        assertEquals(1, master.peers.activeCount(clock.t))
        assertTrue(master.peers.lastContactMillis > 0)
    }

    @Test
    fun `manager without any LAN secret reports off`() = runBlocking {
        val a = client("Door A", "a", secret = null)
        val mgr = LanClientManager(a.client, a.link, { a.cfg }, { listOf(LanEndpoint("master", 1)) }, a.db) { clock.t }
        mgr.tick(false)
        assertEquals(LanHealth.OFF, mgr.health)
    }

    @Test
    fun `manager flags an outdated key instead of failing silently`() = runBlocking {
        val a = client("Door A", "a", secret = ByteArray(32) { 1 })
        val mgr = LanClientManager(a.client, a.link, { a.cfg }, { listOf(LanEndpoint("master", 1)) }, a.db) { clock.t }
        mgr.tick(false)
        assertEquals(LanHealth.KEY_OUTDATED, mgr.health)
    }

    // ─── reconnect push: final server merge rules (docs/SCANNER.md "Offline merge rules") ───

    private val t0 = 1_799_990_000_000 // before the test clock: pushed scan times are never "in the future"

    private fun rep(n: Int, action: ScanAction, at: Long, id: String) = LanReportedScan(
        org.tix.checkin.core.contract.ScanRequest(
            clientScanId = id, eventId = EVENT_A, action = action,
            source = org.tix.checkin.core.contract.ScanSource.CAMERA,
            payload = TestKeys.payload(ticketId(n)), scannedAt = Iso.format(at),
        ),
        ScanResult.ACCEPTED,
    )

    private fun push(from: Device, vararg scans: LanReportedScan): List<Boolean> = runBlocking {
        from.client.push(LanEndpoint("m", 1), EVENT_A, LanPushRequest(from.name, scans.toList())).results.map { it.applied }
    }

    private fun masterTicket(n: Int) = master.db.tickets.getValue(ticketId(n))
    private val min = 60_000L

    @Test
    fun `copied QR - A 18-50 then C 19-05 - one entry, first entry A`() {
        val a = client("Door A", "a"); val c = client("Door C", "c")
        seed(1, master.db)
        assertEquals(listOf(true), push(a, rep(1, ScanAction.CHECK_IN, t0, "a1")))
        assertEquals(listOf(false), push(c, rep(1, ScanAction.CHECK_IN, t0 + 15 * min, "c1"))) // DUPLICATE_ENTRY
        val t = masterTicket(1)
        assertEquals(CheckInState.CHECKED_IN, t.checkInState)
        assertEquals(1, t.checkInCount)
        assertEquals("Door A", t.firstCheckedInDeviceName)
        assertEquals(Iso.format(t0), t.firstCheckedInAt)
    }

    @Test
    fun `copied QR - C 19-05 then A 18-50 - one entry, first entry A`() {
        val a = client("Door A", "a"); val c = client("Door C", "c")
        seed(1, master.db)
        assertEquals(listOf(true), push(c, rep(1, ScanAction.CHECK_IN, t0 + 15 * min, "c1")))
        assertEquals("Door C", masterTicket(1).firstCheckedInDeviceName)
        // The older entry is a stale duplicate: state untouched, but it owns the stay.
        assertEquals(listOf(true), push(a, rep(1, ScanAction.CHECK_IN, t0, "a1")))
        val t = masterTicket(1)
        assertEquals(CheckInState.CHECKED_IN, t.checkInState)
        assertEquals(1, t.checkInCount)
        assertEquals(Iso.format(t0 + 15 * min), t.lastScanAt)
        assertEquals("Door A", t.firstCheckedInDeviceName)
        assertEquals(Iso.format(t0), t.firstCheckedInAt)
    }

    @Test
    fun `copied QR with a check-out in between - both entries real, state stays`() {
        val a = client("Door A", "a"); val c = client("Door C", "c")
        seed(1, master.db)
        push(c, rep(1, ScanAction.CHECK_IN, t0 + 15 * min, "c1"))
        // Same upload: IN 18:50, OUT 19:00 (before C's entry at 19:05).
        val applied = push(a, rep(1, ScanAction.CHECK_OUT, t0 + 10 * min, "a2"), rep(1, ScanAction.CHECK_IN, t0, "a1"))
        assertEquals(listOf(false, true), applied) // results stay in request order
        val t = masterTicket(1)
        assertEquals(CheckInState.CHECKED_IN, t.checkInState)
        assertEquals(1, t.checkInCount)
        assertEquals("Door A", t.firstCheckedInDeviceName)
        // The decision for the exception is ACCEPTED (see DecisionTest); the table input is what the master feeds it.
        val d = org.tix.checkin.core.scan.decideScan(
            org.tix.checkin.core.scan.DecisionInput(
                ScanAction.CHECK_IN,
                org.tix.checkin.core.scan.DecisionTicket(org.tix.checkin.core.contract.TicketStatus.VALID, CheckInState.CHECKED_IN, false, null, false, null),
                null, true, stale = true, scannedBeforeFirstEntry = true, exitBetween = true,
            ),
        )
        assertEquals(ScanResult.ACCEPTED, d.result)
        assertNull(d.nextState)
    }

    @Test
    fun `a batch is applied in scannedAt order, not request order`() {
        val a = client("Door A", "a")
        seed(1, master.db)
        push(a, rep(1, ScanAction.CHECK_OUT, t0 + 10 * min, "o"), rep(1, ScanAction.CHECK_IN, t0, "i"))
        assertEquals(CheckInState.CHECKED_OUT, masterTicket(1).checkInState)
    }

    @Test
    fun `reviewer A - a late offline check-in between an IN and an OUT does not flip the state`() {
        val x = client("Door X", "x"); val y = client("Door Y", "y")
        seed(1, master.db)
        push(x, rep(1, ScanAction.CHECK_IN, t0, "x1"), rep(1, ScanAction.CHECK_OUT, t0 + 60 * min, "x2"))
        assertEquals(CheckInState.CHECKED_OUT, masterTicket(1).checkInState)
        assertEquals(listOf(false), push(y, rep(1, ScanAction.CHECK_IN, t0 + 30 * min, "y1")))
        val t = masterTicket(1)
        assertEquals(CheckInState.CHECKED_OUT, t.checkInState)
        assertEquals(1, t.checkInCount)
        assertEquals("Door X", t.firstCheckedInDeviceName)
    }

    @Test
    fun `reviewer B - a late offline check-out does not flip CHECKED_IN to CHECKED_OUT`() {
        val x = client("Door X", "x"); val y = client("Door Y", "y")
        seed(1, master.db)
        push(x, rep(1, ScanAction.CHECK_IN, t0, "x1"), rep(1, ScanAction.CHECK_OUT, t0 + 10 * min, "x2"), rep(1, ScanAction.CHECK_IN, t0 + 20 * min, "x3"))
        assertEquals(CheckInState.CHECKED_IN, masterTicket(1).checkInState)
        assertEquals(listOf(false), push(y, rep(1, ScanAction.CHECK_OUT, t0 + 15 * min, "y1")))
        assertEquals(CheckInState.CHECKED_IN, masterTicket(1).checkInState)
        assertEquals(Iso.format(t0 + 20 * min), masterTicket(1).lastScanAt)
    }

    private fun Device.scanLocalDirect(n: Int) {
        runBlocking { local.scan(ScanCommand("m-$n", EVENT_A, ScanAction.CHECK_IN, org.tix.checkin.core.contract.ScanSource.CAMERA, payload = TestKeys.payload(ticketId(n)), scannedAtMillis = clock.nowMillis())) }
        // A scan on the master itself is numbered for the feed by the store; FakeDb.commit does not, so do it here.
        db.tickets[ticketId(n)]?.let { runBlocking { db.commitLan(it) } }
    }
}
