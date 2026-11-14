package org.tix.checkin.core.scan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.FirstScan
import org.tix.checkin.core.contract.LookupResponse
import org.tix.checkin.core.contract.ManifestResult
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanBatchResponse
import org.tix.checkin.core.contract.ScanColor
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.ScanRequest
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.ScanTicketDisplay
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.ScannerApi
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.contract.TicketStatus

private class FixedClock(var now: Long = 1_800_000_000_000) : Clock {
    override fun nowMillis() = now.also { now += 1000 }
}

class LocalScanAuthorityTest {
    private val db = FakeDb()
    private var cfg = config()
    private val authority = LocalScanAuthority({ cfg }, db)
    private val clock = FixedClock()
    private val coordinator = ScanCoordinator(authority, { cfg }, clock)

    private fun scan(n: Int, action: ScanAction = ScanAction.CHECK_IN, payload: String = TestKeys.payload(ticketId(n))) =
        runBlocking { coordinator.scanCode(payload, action, EVENT_A) }

    @Test
    fun `valid ticket is green, updates state, and a second scan is red with first-scan info`() {
        db.tickets[ticketId(1)] = localTicket(1)
        val first = scan(1)
        assertEquals(ScanResult.ACCEPTED, first.result)
        assertEquals(ScanColor.GREEN, first.color)
        assertEquals("Max Muster", first.ticket?.attendeeName)
        val stored = db.tickets.getValue(ticketId(1))
        assertEquals(CheckInState.CHECKED_IN, stored.checkInState)
        assertTrue(stored.localDirty)
        assertEquals("Door A", stored.firstCheckedInDeviceName)
        assertEquals(1, stored.checkInCount)

        val second = scan(1)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, second.result)
        assertEquals(ScanColor.RED, second.color)
        assertEquals("Door A", second.firstScan?.deviceName)
        assertNotNull(second.firstScan?.at)
        assertEquals(2, db.journal.size)
        assertTrue(db.journal.none { it.uploaded })
    }

    @Test
    fun `check-out then re-entry`() {
        db.tickets[ticketId(1)] = localTicket(1)
        assertEquals(ScanResult.REJECTED_NOT_CHECKED_IN, scan(1, ScanAction.CHECK_OUT).result)
        scan(1)
        assertEquals(ScanResult.ACCEPTED, scan(1, ScanAction.CHECK_OUT).result)
        assertEquals(CheckInState.CHECKED_OUT, db.tickets.getValue(ticketId(1)).checkInState)
        assertEquals(ScanResult.ACCEPTED, scan(1).result)
        assertEquals(CheckInState.CHECKED_IN, db.tickets.getValue(ticketId(1)).checkInState)
    }

    @Test
    fun `check-out is refused when the event does not allow it`() {
        cfg = config(allowCheckOut = false)
        db.tickets[ticketId(1)] = localTicket(1, state = CheckInState.CHECKED_IN)
        assertEquals(ScanResult.REJECTED_CHECK_OUT_NOT_ALLOWED, scan(1, ScanAction.CHECK_OUT).result)
    }

    @Test
    fun `unknown ticket with a valid signature is admitted provisionally and a repeat is red`() {
        val v = scan(7)
        assertEquals(ScanResult.ACCEPTED, v.result)
        assertTrue(v.provisional)
        assertEquals("Stalls|B|7", v.ticket?.sectionLabel)
        val stub = db.tickets.getValue(ticketId(7))
        assertTrue(stub.provisional)
        assertTrue(stub.localDirty)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, scan(7).result)
    }

    // ─── offline box-office ticket (sold after the last sync) ───

    @Test
    fun `box office ticket sold after the last sync is admitted offline - box office payload shape (GA seat info, long seat info)`() {
        for ((n, seat) in listOf(11 to "GA:", 12 to "GA:Stalls", 13 to "|", 14 to "Balcony Left Extra Wide|Row AAAAAAAAAA|Seat 1234567890")) {
            val v = scan(n, payload = TestKeys.payload(ticketId(n), seatInfo = seat))
            assertEquals(ScanResult.ACCEPTED, v.result, seat)
            assertTrue(v.provisional, seat)
            assertEquals(ScanColor.GREEN, v.color)
        }
        assertEquals(4, db.journal.size)
    }

    @Test
    fun `key rotated after the last sync keeps the invalid-signature result but flags the unknown key`() {
        db.tickets[ticketId(9)] = localTicket(9)
        val rotated = scan(9, payload = TestKeys.payload(ticketId(9), keyId = "k2"))
        assertEquals(ScanResult.REJECTED_INVALID_SIGNATURE, rotated.result)
        assertTrue(rotated.unknownKey)
        // a forged signature under a known key is plainly invalid: no key hint
        val forged = scan(9, payload = TestKeys.payload(ticketId(9), signWith = TestKeys.otherSeed))
        assertEquals(ScanResult.REJECTED_INVALID_SIGNATURE, forged.result)
        assertFalse(forged.unknownKey)
    }

    @Test
    fun `key missing in the manifest is an invalid signature, never an unknown ticket`() {
        // first ticket of an event created after the last manifest: the key is not known yet
        assertEquals(ScanResult.REJECTED_INVALID_SIGNATURE, scan(9, payload = TestKeys.payload(ticketId(9), keyId = "k2")).result)
    }

    @Test
    fun `check-out of a validly signed but unsynced ticket is an info notice, not recorded`() {
        val v = scan(8, ScanAction.CHECK_OUT)
        assertNull(v.result)
        assertEquals(VerdictNotice.NOT_SYNCED_CHECK_OUT, v.notice)
        assertTrue(v.notice!!.isInfo)
        assertTrue(db.journal.isEmpty())
        assertTrue(db.tickets.isEmpty())
        // check-in of the same ticket is still admitted (the toggle only changes the answer for this ticket)
        assertEquals(ScanResult.ACCEPTED, scan(8).result)
    }

    @Test
    fun `check-out of an unsynced ticket with a bad signature stays red`() {
        assertEquals(ScanResult.REJECTED_INVALID_SIGNATURE, scan(8, ScanAction.CHECK_OUT, TestKeys.payload(ticketId(8), signWith = TestKeys.otherSeed)).result)
    }

    @Test
    fun `manual scan of a ticket this device does not know is an info notice, not recorded`() {
        for (action in ScanAction.entries) {
            val v = runBlocking { coordinator.scanTicket(ticketId(99), EVENT_A, action) }
            assertEquals(VerdictNotice.NOT_IN_OFFLINE_LIST, v.notice)
            assertNull(v.result)
        }
        assertTrue(db.journal.isEmpty())
    }

    @Test
    fun `manual scan by ticket code that is not in the local list is an info notice`() {
        val v = runBlocking { LocalScanAuthority({ cfg }, db).scan(ScanCommand("c1", EVENT_A, ScanAction.CHECK_IN, ScanSource.MANUAL, ticketCode = "ZZZZZZZZZZ", scannedAtMillis = 1L)) }
        assertEquals(VerdictNotice.NOT_IN_OFFLINE_LIST, v.notice)
    }

    @Test
    fun `tombstones are red`() {
        for ((i, status) in listOf(TicketStatus.CANCELLED, TicketStatus.REFUNDED, TicketStatus.REPLACED).withIndex()) {
            db.tickets[ticketId(i + 1)] = localTicket(i + 1, status = status)
            assertEquals(ScanResult.REJECTED_TICKET_VOID, scan(i + 1).result, status.name)
        }
        assertTrue(db.tickets.values.all { it.checkInState == CheckInState.NONE })
    }

    @Test
    fun `bad signature, revoked key and unknown key id are red`() {
        db.tickets[ticketId(1)] = localTicket(1)
        assertEquals(
            ScanResult.REJECTED_INVALID_SIGNATURE,
            scan(1, payload = TestKeys.payload(ticketId(1), signWith = TestKeys.otherSeed)).result,
        )
        assertEquals(ScanResult.REJECTED_INVALID_SIGNATURE, scan(1, payload = TestKeys.payload(ticketId(1), keyId = "k9")).result)
        cfg = config(revokedKey = true)
        assertEquals(ScanResult.REJECTED_INVALID_SIGNATURE, scan(1).result)
        assertEquals(CheckInState.NONE, db.tickets.getValue(ticketId(1)).checkInState)
    }

    @Test
    fun `wrong event and malformed payloads are red`() {
        val wrong = scan(1, payload = TestKeys.payload(ticketId(1), eventId = EVENT_B))
        assertEquals(ScanResult.REJECTED_WRONG_EVENT, wrong.result)
        assertEquals(ScanColor.RED, wrong.color)
        assertEquals(0, db.journal.size, "scans of unassigned events are not journaled")
        assertEquals(ScanResult.REJECTED_MALFORMED, scan(1, payload = "https://example.org").result)
        assertEquals(1, db.journal.size)
    }

    @Test
    fun `warnings - proof text, entrance, seat feature, additional payment`() {
        cfg = config(entrance = ENTRANCE_S)
        db.tickets[ticketId(1)] = localTicket(1, type = TYPE_REDUCED, section = SECTION_N, feature = SeatFeature.COMPANION_SEAT, additionalPaymentOpen = true)
        val v = scan(1)
        assertEquals(ScanResult.ACCEPTED_WITH_WARNING, v.result)
        assertEquals(ScanColor.YELLOW, v.color)
        assertEquals(
            listOf(ScanWarning.DISCOUNT_PROOF_REQUIRED, ScanWarning.WRONG_ENTRANCE, ScanWarning.SEAT_FEATURE, ScanWarning.ADDITIONAL_PAYMENT_OPEN),
            v.warnings,
        )
        assertEquals("Bitte Ermaessigungsnachweis pruefen!", v.warningTexts[ScanWarning.DISCOUNT_PROOF_REQUIRED.name])
        assertEquals("Reduced", v.ticket?.ticketTypeName)
        assertEquals(CheckInState.CHECKED_IN, db.tickets.getValue(ticketId(1)).checkInState)
    }

    @Test
    fun `no entrance warning when the blocks entrance matches or the device has none`() {
        cfg = config(entrance = ENTRANCE_N)
        db.tickets[ticketId(1)] = localTicket(1, section = SECTION_N)
        assertEquals(ScanResult.ACCEPTED, scan(1).result)
    }

    @Test
    fun `offline mode not allowed refuses without a decision or journal`() {
        cfg = config(offlineAllowed = false)
        db.tickets[ticketId(1)] = localTicket(1)
        val v = scan(1)
        assertNull(v.result)
        assertEquals(VerdictNotice.OFFLINE_NOT_ALLOWED, v.notice)
        assertEquals(ScanColor.RED, v.color)
        assertTrue(db.journal.isEmpty())
        assertEquals(CheckInState.NONE, db.tickets.getValue(ticketId(1)).checkInState)
    }

    @Test
    fun `manual scan by ticket id needs no signature`() {
        db.tickets[ticketId(1)] = localTicket(1)
        val v = runBlocking { coordinator.scanTicket(ticketId(1), EVENT_A, ScanAction.CHECK_IN) }
        assertEquals(ScanResult.ACCEPTED, v.result)
        assertEquals(ScanSource.MANUAL, db.journal.single().source)
    }

    @Test
    fun `the payload event decides on a device with several events`() {
        val a = cfg.events.getValue(EVENT_A)
        val twoEvents = ConfigSnapshot(true, "Door A", mapOf(EVENT_A to a, EVENT_B to a.run {
            EventConfig(EVENT_B, "Second", null, false, keys, ticketTypes, sectionEntrances)
        }))
        cfg = twoEvents
        db.tickets[ticketId(1)] = localTicket(1, eventId = EVENT_B)
        // selected event is A, the ticket belongs to B (same keys in this fixture): accepted for B.
        val v = runBlocking { coordinator.scanCode(TestKeys.payload(ticketId(1), eventId = EVENT_B), ScanAction.CHECK_IN, EVENT_A) }
        assertEquals(ScanResult.ACCEPTED, v.result)
        assertEquals(EVENT_B, db.journal.single().eventId)
    }
}

/** Fake API with scripted behaviour. */
class FakeApi : ScannerApi {
    var scanHandler: suspend (ScanRequest) -> ScanOutcome = { error("no scan handler") }
    var batchHandler: suspend (List<ScanRequest>) -> ScanBatchResponse = { error("no batch handler") }
    var syncHandler: suspend (String, String?, Int) -> SyncPage = { _, _, _ -> error("no sync handler") }
    val sentAts = ArrayList<String>()
    val scans = ArrayList<ScanRequest>()
    val batches = ArrayList<List<ScanRequest>>()

    override suspend fun manifest(etag: String?): ManifestResult = ManifestResult.NotModified
    override suspend fun sync(eventId: String, cursor: String?, limit: Int) = syncHandler(eventId, cursor, limit)
    override suspend fun scan(request: ScanRequest): ScanOutcome = scanHandler(request).also { scans += request }
    override suspend fun scanBatch(requests: List<ScanRequest>, sentAt: String): ScanBatchResponse {
        batches += requests
        sentAts += sentAt
        return batchHandler(requests)
    }

    override suspend fun lookup(eventId: String, query: String, limit: Int) = LookupResponse()
    override suspend fun latestApp() = null
}

fun outcomeFor(
    req: ScanRequest,
    result: ScanResult = ScanResult.ACCEPTED,
    state: CheckInState = CheckInState.CHECKED_IN,
    first: FirstScan? = null,
) = ScanOutcome(
    clientScanId = req.clientScanId,
    result = result,
    warnings = emptyList(),
    ticket = ScanTicketDisplay(req.ticketId ?: "t", state = state),
    firstScan = first,
)

private fun ScanTicketDisplay(id: String, state: CheckInState) =
    ScanTicketDisplay(id = id, ticketCode = "C", categoryName = "Cat 1", checkInState = state)

class FallbackAuthorityTest {
    private val db = FakeDb()
    private val api = FakeApi()
    private val cfg = config()
    private val local = LocalScanAuthority({ cfg }, db)
    private var usable = true
    private var failures = 0
    private var successes = 0
    private val link = object : ServerLink {
        override fun isUsable() = usable
        override fun onSuccess() { successes++ }
        override fun onFailure(error: Throwable) { failures++; usable = false }
    }
    private val server = ServerScanAuthority(api, db, timeoutMillis = 200)
    private val authority = FallbackScanAuthority(server, local, link, db)
    private val coordinator = ScanCoordinator(authority, { cfg }, FixedClock())

    private fun scan(n: Int) = runBlocking { coordinator.scanCode(TestKeys.payload(ticketId(n)), ScanAction.CHECK_IN, EVENT_A) }

    @Test
    fun `server answer wins and is journaled as uploaded`() {
        db.tickets[ticketId(1)] = localTicket(1)
        api.scanHandler = { req ->
            ScanOutcome(req.clientScanId, ScanResult.REJECTED_ALREADY_CHECKED_IN, ticket = ScanTicketDisplay(ticketId(1), "C", TicketStatus.VALID, "Max", "Cat 1", "Normal", "Stalls", "B", "1", null, CheckInState.CHECKED_IN),
                firstScan = FirstScan("2026-11-10T18:00:00Z", "Door B"))
        }
        val v = scan(1)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, v.result)
        assertEquals(DecidedBy.SERVER, v.decidedBy)
        assertEquals("Door B", v.firstScan?.deviceName)
        assertTrue(db.journal.single().uploaded)
        assertEquals(CheckInState.CHECKED_IN, db.tickets.getValue(ticketId(1)).checkInState)
        assertEquals("Door B", db.tickets.getValue(ticketId(1)).firstCheckedInDeviceName)
        assertEquals(1, successes)
        assertEquals(ScanRequestKind.CAMERA_PAYLOAD, kind(api.scans.single()))
    }

    private enum class ScanRequestKind { CAMERA_PAYLOAD }
    private fun kind(r: ScanRequest) = if (r.payload != null && r.ticketId == null && r.ticketCode == null) ScanRequestKind.CAMERA_PAYLOAD else error("bad request")

    @Test
    fun `network error falls back to the local decision with the same client scan id`() {
        db.tickets[ticketId(1)] = localTicket(1)
        api.scanHandler = { throw NetworkException("down") }
        val v = scan(1)
        assertEquals(ScanResult.ACCEPTED, v.result)
        assertEquals(DecidedBy.LOCAL, v.decidedBy)
        assertEquals(1, failures)
        assertFalse(db.journal.single().uploaded)
        // the link is down now: the next scan does not even try the server
        api.scanHandler = { error("must not be called") }
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, scan(1).result)
    }

    @Test
    fun `a slow server times out and the scan is decided locally`() {
        db.tickets[ticketId(1)] = localTicket(1)
        api.scanHandler = { delay(5_000); error("never") }
        val started = System.currentTimeMillis()
        val v = scan(1)
        assertTrue(System.currentTimeMillis() - started < 2_000)
        assertEquals(DecidedBy.LOCAL, v.decidedBy)
        assertEquals(ScanResult.ACCEPTED, v.result)
    }

    @Test
    fun `unsynced box office ticket is admitted when the server is unreachable (timeout, network error, link down)`() {
        api.scanHandler = { throw NetworkException("airplane mode") }
        val first = scan(21)
        assertEquals(ScanResult.ACCEPTED, first.result)
        assertEquals(DecidedBy.LOCAL, first.decidedBy)
        assertTrue(first.provisional)
        // link is down now: no server attempt at all
        assertEquals(ScanResult.ACCEPTED, scan(22).result)
        // slow server
        usable = true
        api.scanHandler = { delay(5_000); error("never") }
        assertEquals(ScanResult.ACCEPTED, scan(23).result)
    }

    @Test
    fun `an offline check-out of an unsynced ticket gives the info notice through the fallback chain`() {
        usable = false
        val v = runBlocking { coordinator.scanCode(TestKeys.payload(ticketId(24)), ScanAction.CHECK_OUT, EVENT_A) }
        assertEquals(VerdictNotice.NOT_SYNCED_CHECK_OUT, v.notice)
        assertTrue(db.journal.isEmpty())
    }

    @Test
    fun `a LAN master that cannot decide falls back to the local notice`() {
        val lan = object : ScanAuthority {
            override suspend fun scan(command: ScanCommand): ScanVerdict = throw NetworkException("master says: no decision")
        }
        usable = false
        val a = FallbackScanAuthority(server, local, link, db, lan)
        val v = runBlocking { ScanCoordinator(a, { cfg }, FixedClock()).scanCode(TestKeys.payload(ticketId(25)), ScanAction.CHECK_OUT, EVENT_A) }
        assertEquals(VerdictNotice.NOT_SYNCED_CHECK_OUT, v.notice)
    }

    @Test
    fun `maintenance 503 falls back`() {
        db.tickets[ticketId(1)] = localTicket(1)
        api.scanHandler = { throw ApiException(503, "MAINTENANCE", "restore running", 60) }
        assertEquals(DecidedBy.LOCAL, scan(1).decidedBy)
    }

    @Test
    fun `a ticket with an unsent local scan is decided locally even when the server is reachable`() {
        db.tickets[ticketId(1)] = localTicket(1)
        usable = false
        scan(1)
        usable = true
        api.scanHandler = { error("server must not decide a ticket with pending local state") }
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, scan(1).result)
    }

    @Test
    fun `event not assigned is a red verdict without falling back`() {
        api.scanHandler = { throw ApiException(403, "EVENT_NOT_ASSIGNED", "no") }
        val v = scan(1)
        assertEquals(ScanColor.RED, v.color)
        assertEquals(VerdictNotice.EVENT_NOT_ASSIGNED, v.notice)
        assertTrue(db.journal.isEmpty())
    }

    @Test
    fun `offline not allowed shows the notice when the server is unreachable`() {
        val strict = config(offlineAllowed = false)
        val strictLocal = LocalScanAuthority({ strict }, db)
        val a = FallbackScanAuthority(server, strictLocal, link, db)
        api.scanHandler = { throw NetworkException("down") }
        val v = runBlocking { ScanCoordinator(a, { strict }, FixedClock()).scanCode(TestKeys.payload(ticketId(1)), ScanAction.CHECK_IN, EVENT_A) }
        assertEquals(VerdictNotice.OFFLINE_NOT_ALLOWED, v.notice)
    }
}
