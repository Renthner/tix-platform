package org.tix.checkin.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.SyncTicket
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.scan.Merge

/** After a server restore (new sync epoch) the retained unsent rows must still accept later server updates. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RestoreResetTest {
    private lateinit var db: TixDatabase
    private lateinit var dao: TixDao
    private lateinit var store: RoomStore

    @Before
    fun open() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, TixDatabase::class.java).allowMainThreadQueries().build()
        dao = db.dao()
        store = RoomStore(db)
    }

    @After
    fun close() = db.close()

    private fun ticket(id: String, version: Long, dirty: Boolean, lanDirty: Boolean = false, state: String = "NONE") = TicketEntity(
        id = id, ticketCode = "CODE$id", status = "VALID", eventId = "ev1", keyId = "k1", sectionId = "s", sectionLabel = "Stalls",
        rowLabel = "B", seatLabel = "7", seatFeature = null, categoryId = "c", categoryName = "Cat", ticketTypeId = "t",
        attendeeName = "Max Muster", checkInState = state, firstCheckedInAt = null, firstCheckedInDeviceName = null,
        checkInCount = if (state == "CHECKED_IN") 1 else 0, lastScanAt = null, additionalPaymentOpen = false,
        syncVersion = version, provisional = false, localDirty = dirty, lanDirty = lanDirty,
    )

    @Test
    fun `restore with unsent local row - later server void is not ignored`() = runBlocking {
        // server counter was at 100 before the restore; the restored server restarts lower
        dao.putTickets(
            listOf(
                ticket("unsent", 100, dirty = true, state = "CHECKED_IN"),
                ticket("lan", 100, dirty = false, lanDirty = true, state = "CHECKED_IN"),
                ticket("clean", 100, dirty = false),
            ),
        )
        store.resetSyncData("epoch-2")

        assertNull(dao.ticket("clean"))
        assertEquals(0L, dao.ticket("unsent")!!.syncVersion)
        assertEquals(0L, dao.ticket("lan")!!.syncVersion)

        // the restored server delivers the ticket again (low version) and later voids it
        val existing = mapOf("unsent" to dao.ticket("unsent")!!.toLocal())
        val first = Merge.mergePage(existing, listOf(SyncTicket(id = "unsent", ticketCode = "CODEunsent", status = TicketStatus.VALID, eventId = "ev1", checkInState = CheckInState.NONE, syncVersion = 3)))
        dao.putTickets(first.map { it.ticket.toEntity() })
        val afterFirst = dao.ticket("unsent")!!
        assertEquals(3L, afterFirst.syncVersion)
        assertEquals("CHECKED_IN", afterFirst.checkInState) // the unsent local check-in is kept
        assertTrue(afterFirst.localDirty)

        val void = Merge.mergePage(
            mapOf("unsent" to afterFirst.toLocal()),
            listOf(SyncTicket(id = "unsent", ticketCode = "CODEunsent", status = TicketStatus.CANCELLED, eventId = "ev1", checkInState = CheckInState.NONE, syncVersion = 4)),
        )
        assertEquals(TicketStatus.CANCELLED, void.single().ticket.status)
    }

    @Test
    fun `without the reset a lower server version is ignored (the bug)`() = runBlocking {
        dao.putTicket(ticket("unsent", 100, dirty = true, state = "CHECKED_IN"))
        val merged = Merge.mergePage(
            mapOf("unsent" to dao.ticket("unsent")!!.toLocal()),
            listOf(SyncTicket(id = "unsent", ticketCode = "CODEunsent", status = TicketStatus.CANCELLED, eventId = "ev1", checkInState = CheckInState.NONE, syncVersion = 4)),
        )
        assertEquals(TicketStatus.VALID, merged.single().ticket.status)
    }
}
