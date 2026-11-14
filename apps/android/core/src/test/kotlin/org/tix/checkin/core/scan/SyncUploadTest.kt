package org.tix.checkin.core.scan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.FirstScan
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanBatchResponse
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.sync.ScanUploader
import org.tix.checkin.core.sync.TicketSync

class TicketSyncTest {
    private val db = FakeDb()
    private val api = FakeApi()

    @Test
    fun `follows hasMore with the opaque cursor and stores the last one`() {
        val seen = ArrayList<String?>()
        api.syncHandler = { _, cursor, _ ->
            seen += cursor
            when (cursor) {
                null -> SyncPage(listOf(syncTicket(1, 1), syncTicket(2, 2)), "cur-a", hasMore = true)
                "cur-a" -> SyncPage(listOf(syncTicket(3, 3)), "cur-b", hasMore = true)
                else -> SyncPage(emptyList(), "cur-b", hasMore = false)
            }
        }
        val n = runBlocking { TicketSync.syncEvent(api, db, EVENT_A) }
        assertEquals(listOf(null, "cur-a", "cur-b"), seen)
        assertEquals(3, n)
        assertEquals("cur-b", db.cursors[EVENT_A])
        assertEquals(3, db.tickets.size)
        // next run starts at the stored cursor
        seen.clear()
        runBlocking { TicketSync.syncEvent(api, db, EVENT_A) }
        assertEquals(listOf<String?>("cur-b"), seen)
    }

    @Test
    fun `a page that claims more but does not advance ends the loop`() {
        var calls = 0
        api.syncHandler = { _, _, _ -> calls++; SyncPage(emptyList(), "same", hasMore = true) }
        runBlocking { TicketSync.syncEvent(api, db, EVENT_A) }
        assertEquals(2, calls)
    }

    @Test
    fun `tombstones are kept and an older duplicate never replaces a newer row`() {
        api.syncHandler = { _, _, _ ->
            SyncPage(
                listOf(syncTicket(1, 5, status = TicketStatus.CANCELLED), syncTicket(1, 4), syncTicket(2, 2)),
                "c", hasMore = false,
            )
        }
        runBlocking { TicketSync.syncEvent(api, db, EVENT_A) }
        assertEquals(TicketStatus.CANCELLED, db.tickets.getValue(ticketId(1)).status)
        assertEquals(5L, db.tickets.getValue(ticketId(1)).syncVersion)
    }

    @Test
    fun `delta rows do not overwrite an unsent local check-in but a tombstone does`() {
        db.tickets[ticketId(1)] = localTicket(1).copy(checkInState = CheckInState.CHECKED_IN, checkInCount = 1, localDirty = true, syncVersion = 1)
        db.tickets[ticketId(2)] = localTicket(2).copy(checkInState = CheckInState.CHECKED_IN, localDirty = true, syncVersion = 1)
        api.syncHandler = { _, _, _ ->
            SyncPage(listOf(syncTicket(1, 10, state = CheckInState.NONE), syncTicket(2, 10, status = TicketStatus.REFUNDED)), "c")
        }
        runBlocking { TicketSync.syncEvent(api, db, EVENT_A) }
        assertEquals(CheckInState.CHECKED_IN, db.tickets.getValue(ticketId(1)).checkInState)
        assertTrue(db.tickets.getValue(ticketId(1)).localDirty)
        assertEquals(TicketStatus.REFUNDED, db.tickets.getValue(ticketId(2)).status)
    }

    @Test
    fun `a synced row replaces the provisional stub`() {
        runBlocking {
            LocalScanAuthority({ config() }, db).scan(
                ScanCommand("c1", EVENT_A, ScanAction.CHECK_IN, org.tix.checkin.core.contract.ScanSource.CAMERA,
                    payload = TestKeys.payload(ticketId(1)), scannedAtMillis = 1_800_000_000_000),
            )
        }
        assertTrue(db.tickets.getValue(ticketId(1)).provisional)
        api.syncHandler = { _, _, _ -> SyncPage(listOf(syncTicket(1, 3)), "c") }
        runBlocking { TicketSync.syncEvent(api, db, EVENT_A) }
        val t = db.tickets.getValue(ticketId(1))
        assertFalse(t.provisional)
        assertEquals("ABCDEFGH01", t.ticketCode)
        assertEquals(CheckInState.CHECKED_IN, t.checkInState, "unsent local check-in survives")
    }
}

class ScanUploaderTest {
    private val db = FakeDb()
    private val api = FakeApi()
    private val cfg = config()
    private val authority = LocalScanAuthority({ cfg }, db)
    private var t = 1_800_000_000_000L

    private fun localScan(n: Int, action: ScanAction = ScanAction.CHECK_IN) = runBlocking {
        authority.scan(
            ScanCommand(
                "00000000-0000-4000-8000-%012d".format(db.journal.size + 1), EVENT_A, action,
                org.tix.checkin.core.contract.ScanSource.CAMERA, payload = TestKeys.payload(ticketId(n)),
                scannedAtMillis = t.also { t += 1000 },
            ),
        )
    }

    @Test
    fun `uploads in scan order, applies server outcomes and clears the dirty flag`() {
        db.tickets[ticketId(1)] = localTicket(1)
        db.tickets[ticketId(2)] = localTicket(2)
        localScan(1)
        localScan(2)
        api.batchHandler = { reqs -> ScanBatchResponse(reqs.map { outcomeFor(it) }) }
        val report = runBlocking { ScanUploader(api, db).uploadAll() }
        assertEquals(2, report.uploaded)
        assertTrue(db.journal.all { it.uploaded && it.serverResult == ScanResult.ACCEPTED && !it.conflict })
        assertTrue(db.tickets.values.none { it.localDirty })
        assertEquals(1, api.batches.size)
        assertEquals(1, api.sentAts.size)
        assertEquals(listOf(ScanAction.CHECK_IN, ScanAction.CHECK_IN), api.batches[0].map { it.action })
        assertTrue(api.batches[0].all { it.payload != null && it.ticketId == null && it.ticketCode == null })
    }

    @Test
    fun `an offline green that the server rejects becomes a conflict and adopts the server state`() {
        db.tickets[ticketId(1)] = localTicket(1)
        localScan(1)
        api.batchHandler = { reqs ->
            ScanBatchResponse(reqs.map { outcomeFor(it, ScanResult.REJECTED_ALREADY_CHECKED_IN, CheckInState.CHECKED_IN, FirstScan("2026-11-10T17:00:00Z", "Door B")) })
        }
        runBlocking { ScanUploader(api, db).uploadAll() }
        val e = db.journal.single()
        assertTrue(e.conflict)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, e.serverResult)
        val ticket = db.tickets.getValue(ticketId(1))
        assertEquals("Door B", ticket.firstCheckedInDeviceName)
        assertFalse(ticket.localDirty)
    }

    @Test
    fun `dirty stays while another scan of the same ticket is unsent`() {
        db.tickets[ticketId(1)] = localTicket(1)
        localScan(1)
        localScan(1, ScanAction.CHECK_OUT)
        val first = db.journal.first()
        runBlocking { db.applyOutcome(first, outcomeFor(org.tix.checkin.core.contract.ScanRequest(first.clientScanId, EVENT_A, ScanAction.CHECK_IN, org.tix.checkin.core.contract.ScanSource.CAMERA, scannedAt = "x"))) }
        assertTrue(db.tickets.getValue(ticketId(1)).localDirty)
    }

    @Test
    fun `a rejected batch is bisected and the poison scan quarantined`() {
        for (n in 1..4) db.tickets[ticketId(n)] = localTicket(n)
        for (n in 1..4) localScan(n)
        val poison = db.journal[2].clientScanId
        api.batchHandler = { reqs ->
            if (reqs.any { it.clientScanId == poison }) throw ApiException(422, "VALIDATION_FAILED", "bad") else ScanBatchResponse(reqs.map { outcomeFor(it) })
        }
        val report = runBlocking { ScanUploader(api, db).uploadAll() }
        assertEquals(3, report.uploaded)
        assertEquals(1, report.quarantined)
        assertTrue(db.journal.all { it.uploaded })
        assertTrue(db.journal[2].uploadError != null)
        assertEquals(0, db.journal.count { !it.uploaded })
    }

    @Test
    fun `outcomes are matched by client scan id when the order differs`() {
        for (n in 1..2) db.tickets[ticketId(n)] = localTicket(n)
        localScan(1)
        localScan(2)
        api.batchHandler = { reqs -> ScanBatchResponse(reqs.reversed().map { outcomeFor(it) }) }
        assertEquals(2, runBlocking { ScanUploader(api, db).uploadAll() }.uploaded)
    }

    @Test
    fun `network errors and revoked tokens propagate and keep the queue`() {
        db.tickets[ticketId(1)] = localTicket(1)
        localScan(1)
        api.batchHandler = { throw NetworkException("down") }
        assertFailsWith<NetworkException> { runBlocking { ScanUploader(api, db).uploadAll() } }
        api.batchHandler = { throw ApiException(401, "DEVICE_REVOKED", "revoked") }
        val e = assertFailsWith<ApiException> { runBlocking { ScanUploader(api, db).uploadAll() } }
        assertTrue(e.isUnauthorized)
        assertFalse(db.journal.single().uploaded)
    }

    @Test
    fun `batches respect the size limit`() {
        for (n in 1..5) db.tickets[ticketId(n)] = localTicket(n)
        for (n in 1..5) localScan(n)
        api.batchHandler = { reqs -> ScanBatchResponse(reqs.map { outcomeFor(it) }) }
        runBlocking { ScanUploader(api, db, batchSize = 2).uploadAll() }
        assertEquals(listOf(2, 2, 1), api.batches.map { it.size })
    }
}

class LocalSearchTest {
    private val t = localTicket(7, attendee = "Erika Mustermann")

    @Test
    fun `matches name, code and whole seat words`() {
        assertTrue(LocalSearch.matches(t, LocalSearch.tokens("muster")))
        assertTrue(LocalSearch.matches(t, LocalSearch.tokens("stalls b 7")))
        assertTrue(LocalSearch.matches(t, LocalSearch.tokens("abcdefgh07")))
        assertFalse(LocalSearch.matches(t, LocalSearch.tokens("stalls b 3")))
        assertFalse(LocalSearch.matches(t, LocalSearch.tokens("")))
    }

    @Test
    fun `prefix by word, diacritics and case folded, code typed with dash or aliases`() {
        val j = localTicket(1, attendee = "Jörg Müller-Lüdenscheidt")
        assertTrue(LocalSearch.matches(j, LocalSearch.tokens("MULLER")))
        assertTrue(LocalSearch.matches(j, LocalSearch.tokens("jorg lud")))
        assertTrue(LocalSearch.matches(j, LocalSearch.tokens("müller-lüd")))
        assertFalse(LocalSearch.matches(j, LocalSearch.tokens("ller"))) // not in the middle of a word
        assertTrue(LocalSearch.matches(t, LocalSearch.tokens("ABCDE-FGH07")))
        assertTrue(LocalSearch.matches(t, LocalSearch.tokens("abcdefgh")))
    }

    @Test
    fun `fts query uses prefix terms of every alphanumeric part`() {
        assertEquals("mus* b* 7*", LocalSearch.ftsQuery(LocalSearch.tokens("Mus b 7")))
        assertEquals("abcde* fghjk*", LocalSearch.ftsQuery(LocalSearch.tokens("ABCDE-FGHJK")))
        assertEquals("a* or* not*", LocalSearch.ftsQuery(LocalSearch.tokens("a OR not"))) // never an operator: lower case + prefix
        assertEquals(null, LocalSearch.ftsQuery(LocalSearch.tokens("\"*-()")))
    }

    @Test
    fun `rank - exact code, code start, name, seat only`() {
        val exact = localTicket(7)
        val byName = localTicket(8, attendee = "Abcdefgh Muster")
        val seat = localTicket(9, attendee = "Someone")
        assertEquals(0, LocalSearch.rank(exact, LocalSearch.tokens("ABCDEFGH07")))
        assertEquals(1, LocalSearch.rank(exact, LocalSearch.tokens("abcdefg")))
        assertEquals(2, LocalSearch.rank(byName, LocalSearch.tokens("muster")))
        assertEquals(3, LocalSearch.rank(seat, LocalSearch.tokens("stalls")))
        val ordered = LocalSearch.sorted(listOf(seat, byName, exact), LocalSearch.tokens("abcdefgh stalls"))
        assertEquals(listOf(3, 2, 1).size, ordered.size)
    }

    @Test
    fun `fold maps letters without a decomposition like the index text does`() {
        assertEquals("soren", LocalSearch.fold("Søren"))
        assertEquals("strauss", LocalSearch.fold("Strauß"))
        assertEquals("lukasz", LocalSearch.fold("Łukasz"))
        assertEquals("oz", LocalSearch.fold("Ö" + "z"))
        assertEquals("soren strauss ab12 gallery c 9", LocalSearch.indexText("Søren Strauß", "AB12", "Gallery", "C", "9", null))
        assertTrue(LocalSearch.matches(localTicket(1, attendee = "Søren Strauß"), LocalSearch.tokens("soren")))
        assertTrue(LocalSearch.matches(localTicket(1, attendee = "Wei Li"), LocalSearch.tokens("li")))
    }

    @Test
    fun `short fts queries - whole words and short prefixes`() {
        assertEquals("b 7", LocalSearch.ftsWholeQuery(LocalSearch.tokens("B 7")))
        assertEquals("a 12", LocalSearch.ftsWholeQuery(LocalSearch.tokens("a 12")))
        assertEquals("b* 7*", LocalSearch.ftsMixedQuery(LocalSearch.tokens("b 7"), 1)) // prefix from length 1: all prefix
        assertEquals("b 7", LocalSearch.ftsMixedQuery(LocalSearch.tokens("b 7"), 2)) // one-letter words stay whole
        assertEquals("li*", LocalSearch.ftsMixedQuery(LocalSearch.tokens("li"), 2))
        assertEquals("a 12*", LocalSearch.ftsMixedQuery(LocalSearch.tokens("a 12"), 2))
        assertEquals(null, LocalSearch.ftsWholeQuery(LocalSearch.tokens("-")))
    }

    @Test
    fun `order number - trailing words, never the leading words alone, exact ranks first`() {
        val o = localTicket(7, attendee = "Erika Mustermann").copy(orderNumber = "TIX-2026-000123")
        for (q in listOf("000123", "2026-000123", "TIX-2026-000123", "tix 2026 000123", "00012", "2026 000123")) {
            assertTrue(LocalSearch.matches(o, LocalSearch.tokens(q)), q)
        }
        for (q in listOf("2026", "tix", "tix-2026", "12", "000124", "026-000123")) {
            assertFalse(LocalSearch.matches(o, LocalSearch.tokens(q)), q)
        }
        assertEquals(0, LocalSearch.rank(o, LocalSearch.tokens("2026-000123")))
        assertEquals(1, LocalSearch.rank(o, LocalSearch.tokens("00012")))
        val other = localTicket(8, attendee = "Someone").copy(orderNumber = "TIX-2026-0001234")
        assertEquals(listOf(o.id, other.id), LocalSearch.sorted(listOf(other, o), LocalSearch.tokens("000123")).map { it.id })
        // the old row without an order number is simply not found by it
        assertFalse(LocalSearch.matches(o.copy(orderNumber = null), LocalSearch.tokens("000123")))
    }

    @Test
    fun `sync delivers the order number and a server without it never erases a known one`() {
        val wire = org.tix.checkin.core.contract.ScannerJson.decodeFromString<org.tix.checkin.core.contract.SyncTicket>(
            """{"id":"x","ticketCode":"ABCDEFGH07","status":"VALID","eventId":"e","syncVersion":3,"orderNumber":"TIX-2026-000123","unknownField":1}""",
        )
        assertEquals("TIX-2026-000123", wire.orderNumber)
        val old = org.tix.checkin.core.contract.ScannerJson.decodeFromString<org.tix.checkin.core.contract.SyncTicket>(
            """{"id":"x","ticketCode":"ABCDEFGH07","status":"VALID","eventId":"e","syncVersion":4}""",
        )
        assertEquals(null, old.orderNumber)
        val stored = Merge.mergeIncoming(null, wire)
        assertEquals("TIX-2026-000123", stored.orderNumber)
        assertEquals("TIX-2026-000123", Merge.mergeIncoming(stored, old).orderNumber)
        assertEquals("TIX-2026-000999", Merge.mergeIncoming(stored, wire.copy(syncVersion = 5, orderNumber = "TIX-2026-000999")).orderNumber)
    }

    @Test
    fun `prefix end is the exclusive upper bound`() {
        assertEquals("mb", LocalSearch.prefixEnd("ma"))
        assertEquals("", LocalSearch.prefixEnd(""))
    }
}
