package org.tix.checkin.core.scan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanResult

class DegradedLinkTest {
    private var now = 1_000_000L
    private val link = DegradedLink({ now }, initialBackoffMillis = 30_000, maxBackoffMillis = 300_000, probeTimeoutMillis = 100)

    @Test
    fun `backoff doubles per failed probe up to the cap and resets on success`() = runBlocking {
        link.onSlowOrUnreachable()
        assertTrue(link.degraded)
        assertEquals(30_000, link.millisUntilProbe())
        val windows = ArrayList<Long>()
        repeat(6) {
            now += link.millisUntilProbe()
            assertEquals(false, link.probeIfDue { throw NetworkException("down") })
            windows += link.millisUntilProbe()
        }
        assertEquals(listOf(60_000L, 120_000L, 240_000L, 300_000L, 300_000L, 300_000L), windows)
        now += 300_000
        assertEquals(true, link.probeIfDue { })
        assertFalse(link.degraded)
        link.onSlowOrUnreachable()
        assertEquals(30_000, link.millisUntilProbe())
    }

    @Test
    fun `probe is not run before the window ends or when healthy`() = runBlocking {
        var calls = 0
        assertNull(link.probeIfDue { calls++ })
        link.onSlowOrUnreachable()
        now += 29_999
        assertNull(link.probeIfDue { calls++ })
        assertEquals(0, calls)
        now += 1
        assertEquals(true, link.probeIfDue { calls++ })
        assertEquals(1, calls)
    }

    @Test
    fun `a probe slower than the scan timeout counts as failed`() = runBlocking {
        link.onSlowOrUnreachable()
        now += 30_000
        assertEquals(false, link.probeIfDue { delay(5_000) })
        assertTrue(link.degraded)
        assertEquals(60_000, link.millisUntilProbe())
    }

    @Test
    fun `a cancellation raised inside the probe while the scope is alive is a failed probe`() = runBlocking {
        link.onSlowOrUnreachable()
        now += 30_000
        assertEquals(false, link.probeIfDue { throw kotlinx.coroutines.CancellationException("inner") })
        assertTrue(link.degraded)
        assertEquals(60_000, link.millisUntilProbe())
    }

    @Test
    fun `a cancelled scope ends the probe by rethrowing`() = runBlocking {
        link.onSlowOrUnreachable()
        now += 30_000
        val job = launch { link.probeIfDue { delay(5_000) } }
        delay(20)
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        assertTrue(link.degraded)
        assertEquals(0, link.millisUntilProbe()) // not counted as a failed probe: still due
    }

    @Test
    fun `a second failure while degraded does not extend the window`() {
        link.onSlowOrUnreachable()
        now += 10_000
        link.onSlowOrUnreachable()
        assertEquals(20_000, link.millisUntilProbe())
    }
}

class ServerLinkTrackerTest {
    private var now = 0L
    private val tracker = ServerLinkTracker(DegradedLink({ now }, probeTimeoutMillis = 100))

    @Test
    fun `network exception degrades, sync success does not restore, probe does`() = runBlocking {
        tracker.onFailure(NetworkException("timeout"))
        assertEquals(Connection.DEGRADED, tracker.state.value)
        assertFalse(tracker.isUsable())
        tracker.onSuccess() // e.g. a slow sync request that finished
        assertEquals(Connection.DEGRADED, tracker.state.value)
        now += 30_000
        assertEquals(true, tracker.probe { })
        assertEquals(Connection.ONLINE, tracker.state.value)
        assertTrue(tracker.isUsable())
    }

    @Test
    fun `server error answers keep the offline semantics, network loss clears degraded`() {
        tracker.onFailure(ApiException(500, "SERVER", "boom"))
        assertEquals(Connection.OFFLINE, tracker.state.value)
        tracker.onSuccess()
        assertEquals(Connection.ONLINE, tracker.state.value)
        tracker.onFailure(NetworkException("x"))
        tracker.onNetworkLost()
        assertEquals(Connection.OFFLINE, tracker.state.value)
        assertFalse(tracker.degraded.degraded)
    }

    @Test
    fun `a scan while degraded never calls the server and decides locally`() = runBlocking {
        val db = FakeDb()
        db.tickets[ticketId(1)] = localTicket(1)
        var serverCalls = 0
        val server = object : ScanAuthority {
            override suspend fun scan(command: ScanCommand): ScanVerdict {
                serverCalls++
                throw NetworkException("timeout")
            }
        }
        val cfg = config()
        val chain = FallbackScanAuthority(server, LocalScanAuthority({ cfg }, db), tracker, db)
        val coordinator = ScanCoordinator(chain, { cfg }, object : Clock {
            override fun nowMillis() = 1_800_000_000_000
        })
        // First scan pays the timeout once, enters DEGRADED and is still decided locally.
        val first = coordinator.scanCode(TestKeys.payload(ticketId(1)), ScanAction.CHECK_IN, EVENT_A)
        assertEquals(ScanResult.ACCEPTED, first.result)
        assertEquals(1, serverCalls)
        assertEquals(Connection.DEGRADED, tracker.state.value)
        // Further scans: no server call; decision semantics unchanged (second scan of a ticket = RED).
        db.tickets[ticketId(2)] = localTicket(2)
        assertEquals(ScanResult.ACCEPTED, coordinator.scanCode(TestKeys.payload(ticketId(2)), ScanAction.CHECK_IN, EVENT_A).result)
        assertEquals(ScanResult.REJECTED_ALREADY_CHECKED_IN, coordinator.scanCode(TestKeys.payload(ticketId(2)), ScanAction.CHECK_IN, EVENT_A).result)
        assertEquals(1, serverCalls)
        assertEquals(CheckInState.CHECKED_IN, db.tickets.getValue(ticketId(2)).checkInState)
        // The probe restores; the server is tried again.
        now += 30_000
        tracker.probe { }
        db.tickets[ticketId(3)] = localTicket(3)
        coordinator.scanCode(TestKeys.payload(ticketId(3)), ScanAction.CHECK_IN, EVENT_A)
        assertEquals(2, serverCalls)
    }
}
