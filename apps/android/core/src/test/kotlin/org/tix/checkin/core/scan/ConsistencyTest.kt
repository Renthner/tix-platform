package org.tix.checkin.core.scan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanBatchResponse
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.ScanTicketDisplay
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.lan.LanTicketState
import org.tix.checkin.core.sync.ScanUploader

/** Reads the ticket, then waits: the decision "has seen VALID" while a delta page tries to write CANCELLED. */
private class GatedStore(private val db: FakeDb) : ScanStore by db {
    val readDone = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()

    override suspend fun ticket(id: String): LocalTicket? {
        val t = db.ticket(id)
        readDone.complete(Unit)
        release.await()
        return t
    }
}

class DbLockTest {
    @Test
    fun `a decision that read VALID cannot overwrite a tombstone written by a racing delta page`() = runBlocking {
        val lock = Mutex()
        val db = FakeDb()
        db.tickets[ticketId(1)] = localTicket(1)
        val gated = GatedStore(db)
        val authority = LocalScanAuthority({ config() }, gated, lock)
        val sync = LockedTicketSyncStore(db, lock)

        val scan = async(Dispatchers.Default) {
            authority.scan(
                ScanCommand("c1", EVENT_A, ScanAction.CHECK_IN, ScanSource.CAMERA, payload = TestKeys.payload(ticketId(1)), scannedAtMillis = 1_800_000_000_000),
            )
        }
        gated.readDone.await() // the decision holds the lock and has read the VALID row
        val page = async(Dispatchers.Default) {
            sync.applyPage(EVENT_A, SyncPage(listOf(syncTicket(1, 9, status = TicketStatus.CANCELLED)), "c"))
        }
        delay(150)
        assertFalse(page.isCompleted, "the page must wait for the decision's critical section")
        gated.release.complete(Unit)
        scan.await()
        page.await()
        assertEquals(TicketStatus.CANCELLED, db.tickets.getValue(ticketId(1)).status, "tombstone wins")
    }

    @Test
    fun `upload outcomes and LAN states wait for the same lock`() = runBlocking {
        val lock = Mutex()
        val db = FakeDb()
        val uploads = LockedJournalUploadStore(db, lock)
        val lan = LockedLanClientStore(db, lock)
        lock.lock()
        val a = async(Dispatchers.Default) { lan.applyStates(emptyList()) }
        val b = async(Dispatchers.Default) { uploads.requeueQuarantined(5) }
        delay(100)
        assertFalse(a.isCompleted)
        assertFalse(b.isCompleted)
        lock.unlock()
        a.await()
        b.await()
    }
}

class LanAdoptTombstoneTest {
    private fun state(t: LocalTicket, status: TicketStatus = TicketStatus.VALID, last: String? = null, check: CheckInState = CheckInState.NONE) = LanTicketState(
        ticketId = t.id, eventId = t.eventId, keyId = t.keyId, status = status, checkInState = check, lastScanAt = last,
        checkInCount = if (check == CheckInState.CHECKED_IN) 1 else 0, display = ScanTicketDisplay(id = t.id, ticketCode = t.ticketCode),
    )

    @Test
    fun `a cancellation learned from the master voids the ticket, also when its scan time is older`() {
        val t = localTicket(1).copy(checkInState = CheckInState.CHECKED_IN, lastScanAt = "2026-11-10T20:00:00.000Z", checkInCount = 1)
        val adopted = Merge.adoptLanState(t, state(t, TicketStatus.CANCELLED, last = "2026-11-10T19:00:00.000Z"), markLocalDirty = false)
        assertNotNull(adopted)
        assertEquals(TicketStatus.CANCELLED, adopted.status)
        assertEquals(CheckInState.CHECKED_IN, adopted.checkInState, "check-in fields keep the newer local state")
    }

    @Test
    fun `a void ticket is never revived by the LAN`() {
        val t = localTicket(1, status = TicketStatus.REFUNDED)
        val adopted = Merge.adoptLanState(t, state(t, TicketStatus.VALID, last = "2026-11-10T20:00:00.000Z", check = CheckInState.CHECKED_IN), false)
        assertEquals(TicketStatus.REFUNDED, adopted?.status)
    }

    @Test
    fun `an unknown void ticket becomes a tombstone row, so a scan of it is RED`() = runBlocking {
        val t = localTicket(1)
        val row = Merge.adoptLanState(null, state(t, TicketStatus.CANCELLED), false)
        assertNotNull(row)
        assertEquals(TicketStatus.CANCELLED, row.status)
        assertFalse(row.lanDirty)
        val db = FakeDb().also { it.tickets[row.id] = row }
        val v = LocalScanAuthority({ config() }, db).scan(
            ScanCommand("c", EVENT_A, ScanAction.CHECK_IN, ScanSource.CAMERA, payload = TestKeys.payload(ticketId(1)), scannedAtMillis = 1_800_000_000_000),
        )
        assertEquals(ScanResult.REJECTED_TICKET_VOID, v.result)
    }

    @Test
    fun `server learned changes are relevant for the LAN feed, unchanged rows are not`() {
        val t = localTicket(1)
        assertFalse(Merge.lanRelevantChange(t, t.copy(syncVersion = 99)))
        assertTrue(Merge.lanRelevantChange(t, t.copy(status = TicketStatus.CANCELLED)))
        assertTrue(Merge.lanRelevantChange(t, t.copy(checkInState = CheckInState.CHECKED_IN)))
        assertTrue(Merge.lanRelevantChange(t, t.copy(lastScanAt = "2026-11-10T20:00:00.000Z")))
        assertFalse(Merge.lanRelevantChange(null, t))
        assertTrue(Merge.lanRelevantChange(null, t.copy(status = TicketStatus.CANCELLED)))
    }
}

class UploadDeferralTest {
    private val db = FakeDb()
    private val api = FakeApi()
    private val authority = LocalScanAuthority({ config() }, db)
    private var t = 1_800_000_000_000L

    private fun localScan(n: Int) = runBlocking {
        authority.scan(
            ScanCommand(
                "00000000-0000-4000-8000-%012d".format(db.journal.size + 1), EVENT_A, ScanAction.CHECK_IN, ScanSource.CAMERA,
                payload = TestKeys.payload(ticketId(n)), scannedAtMillis = t.also { t += 1000 },
            ),
        )
    }

    private fun seed(count: Int) {
        for (n in 1..count) db.tickets[ticketId(n)] = localTicket(n)
        for (n in 1..count) localScan(n)
    }

    @Test
    fun `a whole batch refused with 422 is deferred, nothing is quarantined and the next run retries`() {
        seed(3)
        api.batchHandler = { throw ApiException(422, "VALIDATION_FAILED", "server bug") }
        val report = runBlocking { ScanUploader(api, db, appVersion = 1).uploadAll() }
        assertEquals(0, report.uploaded)
        assertEquals(0, report.quarantined)
        assertEquals(3, report.deferred)
        assertEquals(3, db.journal.count { !it.uploaded })
        api.batchHandler = { reqs -> ScanBatchResponse(reqs.map { outcomeFor(it) }) }
        assertEquals(3, runBlocking { ScanUploader(api, db, appVersion = 1).uploadAll() }.uploaded)
    }

    @Test
    fun `an undecodable 2xx for everything is transient, not a reason to quarantine`() {
        seed(2)
        api.batchHandler = { throw kotlinx.serialization.SerializationException("garbage from a proxy") }
        val report = runBlocking { ScanUploader(api, db).uploadAll() }
        assertEquals(0, report.quarantined)
        assertEquals(2, report.deferred)
        assertTrue(db.journal.none { it.uploaded })
    }

    @Test
    fun `a single refused scan is quarantined only when others of the batch got through`() {
        seed(3)
        val poison = db.journal[1].clientScanId
        api.batchHandler = { reqs ->
            if (reqs.any { it.clientScanId == poison }) throw ApiException(422, "VALIDATION_FAILED", "bad") else ScanBatchResponse(reqs.map { outcomeFor(it) })
        }
        val report = runBlocking { ScanUploader(api, db).uploadAll() }
        assertEquals(2, report.uploaded)
        assertEquals(1, report.quarantined)
        assertEquals(0, report.deferred)
        assertNotNull(db.journal[1].uploadError)
    }

    @Test
    fun `a server that refuses a big batch as a whole costs a bounded number of requests`() {
        seed(100)
        api.batchHandler = { throw ApiException(422, "VALIDATION_FAILED", "server bug") }
        val report = runBlocking { ScanUploader(api, db).uploadAll() }
        assertEquals(0, report.quarantined)
        assertEquals(100, report.deferred)
        assertTrue(api.batches.size <= 2 * ScanUploader.MAX_CONSECUTIVE_REFUSALS, "requests: ${api.batches.size}")
        assertTrue(db.journal.none { it.uploaded })
    }

    @Test
    fun `network errors still propagate`() {
        seed(1)
        api.batchHandler = { throw NetworkException("down") }
        assertFailsWith<NetworkException> { runBlocking { ScanUploader(api, db).uploadAll() } }
    }

    @Test
    fun `quarantined scans are retried after an app update, not before`() {
        seed(2)
        val poison = db.journal[0].clientScanId
        var refuse = true
        api.batchHandler = { reqs ->
            if (refuse && reqs.any { it.clientScanId == poison }) throw ApiException(422, "VALIDATION_FAILED", "bad") else ScanBatchResponse(reqs.map { outcomeFor(it) })
        }
        db.appVersion = 7
        runBlocking { ScanUploader(api, db, appVersion = 7).uploadAll() }
        assertTrue(db.journal[0].uploaded && db.journal[0].uploadError != null)

        // Same version: stays quarantined (no retry storm on every sync).
        refuse = false
        assertEquals(0, runBlocking { ScanUploader(api, db, appVersion = 7).uploadAll() }.uploaded)
        assertNotNull(db.journal[0].uploadError)

        // A new app version tries again and now the server accepts it.
        db.appVersion = 8
        val report = runBlocking { ScanUploader(api, db, appVersion = 8).uploadAll() }
        assertEquals(1, report.uploaded)
        assertNull(db.journal[0].uploadError)
        assertEquals(ScanResult.ACCEPTED, db.journal[0].serverResult)
    }
}
