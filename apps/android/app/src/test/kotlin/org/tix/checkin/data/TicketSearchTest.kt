package org.tix.checkin.data

import android.content.Context
import androidx.room.Room
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TicketSearchTest {
    private lateinit var db: TixDatabase
    private lateinit var dao: TixDao
    private lateinit var search: TicketSearch

    @Before
    fun open() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, TixDatabase::class.java).allowMainThreadQueries().build()
        dao = db.dao()
        search = TicketSearch(dao)
    }

    @After
    fun close() = db.close()

    private fun ticket(
        id: String, code: String, name: String?, section: String = "Stalls", row: String? = "B", seat: String? = "7",
        status: String = "VALID", event: String = "ev1", order: String? = null,
    ) = TicketEntity(
        id = id, ticketCode = code, status = status, eventId = event, keyId = "k1", sectionId = "s", sectionLabel = section,
        rowLabel = row, seatLabel = seat, seatFeature = null, categoryId = "c", categoryName = "Cat", ticketTypeId = "t",
        attendeeName = name, checkInState = "NONE", firstCheckedInAt = null, firstCheckedInDeviceName = null, checkInCount = 0,
        lastScanAt = null, additionalPaymentOpen = false, syncVersion = 1, provisional = false, localDirty = false,
        orderNumber = order,
    )

    private fun ids(query: String, event: String = "ev1") = runBlocking { search.search(event, query).map { it.id } }

    @Test
    fun `name prefix, case and diacritics, several words`() = runBlocking {
        dao.putTickets(
            listOf(
                ticket("1", "ABCDE12345", "Erika Mustermann"),
                ticket("2", "ABCDE12346", "Jörg Müller", "Balcony", "A", "12"),
                ticket("3", "ABCDE12347", "Max Muster", "Balcony", "A", "13"),
            ),
        )
        assertEquals(setOf("1", "3"), ids("muster").toSet())
        assertEquals(listOf("2"), ids("muller")) // diacritics folded: "muller" finds "Müller"
        assertEquals(listOf("2"), ids("jörg müller"))
        assertEquals(listOf("3"), ids("max mus"))
        assertEquals(listOf("2", "3"), ids("balcony a").sorted())
        assertEquals(emptyList<String>(), ids("nobody"))
    }

    @Test
    fun `seat words match whole words only`() = runBlocking {
        dao.putTickets(listOf(ticket("1", "AAAAA00001", "A B", seat = "1"), ticket("2", "AAAAA00002", "C D", seat = "13")))
        assertEquals(listOf("1"), ids("stalls b 1"))
        assertEquals(listOf("2"), ids("stalls b 13"))
    }

    @Test
    fun `exact ticket code ranks first, code typed with dash and typos finds it`() = runBlocking {
        dao.putTickets(
            listOf(
                ticket("1", "ABCDE12345", "Zeta Abcde"),
                ticket("2", "ABCDE12399", "Anna Abcde1"),
                ticket("3", "XXXXX00000", "Abcde12345 Someone"),
            ),
        )
        // exact code first, then another word of the name
        assertEquals(listOf("1", "3"), ids("abcde12345"))
        // code start (rank 1, by name) before a name hit (rank 2)
        assertEquals(listOf("2", "1", "3"), ids("abcde1"))
        assertEquals("1", ids("ABCDE-12345").first())
        assertEquals("1", ids("abcdel2345").first()) // l -> 1 (Crockford alias)
    }

    @Test
    fun `short queries use the range scans`() = runBlocking {
        dao.putTickets(
            listOf(ticket("1", "MA123XXXXX", "Max Muster"), ticket("2", "ZZ123XXXXX", "mia klein"), ticket("3", "BB123XXXXX", "Anna Bauer")),
        )
        assertEquals(listOf("1"), ids("ma"))
        assertEquals(listOf("2"), ids("mi"))
        assertEquals(listOf("3"), ids("an"))
        assertEquals(listOf("1"), ids("MA")) // code prefix and name
        assertEquals(listOf("2"), ids("zz")) // code prefix
    }

    @Test
    fun `short seat lookups and short surnames that are not the first word`() = runBlocking {
        dao.putTickets(
            listOf(
                ticket("1", "AAAAA00001", "Wei Li", "Balcony", "A", "12"),
                ticket("2", "AAAAA00002", "Liam Stone", "Stalls", "B", "7"),
                ticket("3", "AAAAA00003", "Eva Ng", "Stalls", "B", "17"),
                ticket("4", "AAAAA00004", "Tom Fox", "Stalls", "AB", "12"),
            ),
        )
        assertEquals(listOf("2"), ids("b 7"))
        assertEquals(listOf("1"), ids("a 12"))
        assertEquals(setOf("1", "4"), ids("12").toSet())
        assertEquals(setOf("1", "2"), ids("li").toSet()) // the surname "Li" (not the first word) and "Liam"
        assertEquals(listOf("3"), ids("ng"))
        assertEquals(listOf("3"), ids("eva b"))   // mixed: name prefix + whole row
        assertEquals(listOf("2"), ids("stalls b 7"))
        assertEquals(setOf("2", "3"), ids("stalls b").toSet())
    }

    @Test
    fun `diacritics and letters without a decomposition are folded on both sides`() = runBlocking {
        dao.putTickets(
            listOf(
                ticket("1", "AAAAA00001", "Aylin Özdemir"),
                ticket("2", "AAAAA00002", "Søren Kierkegaard"),
                ticket("3", "AAAAA00003", "Anna Strauß"),
                ticket("4", "AAAAA00004", "Łukasz Nowak"),
            ),
        )
        assertEquals(listOf("1"), ids("öz"))
        assertEquals(listOf("1"), ids("oz"))
        assertEquals(listOf("1"), ids("ozdemir"))
        assertEquals(listOf("2"), ids("soren"))
        assertEquals(listOf("2"), ids("søren"))
        assertEquals(listOf("2"), ids("sø"))
        assertEquals(listOf("3"), ids("strauss"))
        assertEquals(listOf("3"), ids("strauß"))
        assertEquals(listOf("4"), ids("lukasz"))
    }

    @Test
    fun `order number - full number, last words and the sequence alone find it, exact ranks first`() = runBlocking {
        dao.putTickets(
            listOf(
                ticket("1", "AAAAA00001", "Zed Buyer", order = "TIX-2026-000123"),
                ticket("2", "AAAAA00002", "Ann Buyer", order = "TIX-2026-000124"),
                ticket("3", "AAAAA00003", "Bob Buyer", order = "TIX-2026-001230"),
                ticket("4", "AAAAA00004", "Cy Buyer", order = "TIX-2026-0001234"),
            ),
        )
        // the exact number ranks before a number that merely starts with it (ticket 4), whatever the buyer name
        assertEquals(listOf("1", "4"), ids("000123"))
        assertEquals(listOf("1", "4"), ids("2026-000123"))
        assertEquals(listOf("1", "4"), ids("TIX-2026-000123"))
        assertEquals(listOf("1", "4"), ids("tix 2026 000123"))
        assertEquals(listOf("4"), ids("TIX-2026-0001234"))
        assertEquals(listOf("3"), ids("00123"))
        assertEquals(setOf("1", "2", "4"), ids("00012").toSet())
        // the leading words alone would hit every ticket: they never count as an order number hit
        assertEquals(emptyList<String>(), ids("2026"))
        assertEquals(emptyList<String>(), ids("tix"))
        // the order number follows an update of the row
        dao.putTicket(ticket("1", "AAAAA00001", "Zed Buyer", order = "TIX-2026-000999"))
        assertEquals(emptyList<String>(), ids("000123").filter { it == "1" })
        assertEquals(listOf("1"), ids("000999"))
    }

    @Test
    fun `search is per event and the index follows updates, REPLACE-free upserts and deletes`() = runBlocking {
        dao.putTickets(listOf(ticket("1", "ABCDE12345", "Erika Mustermann"), ticket("9", "ABCDE99999", "Erika Other", event = "ev2")))
        assertEquals(listOf("1"), ids("erika"))
        assertEquals(listOf("9"), ids("erika", "ev2"))
        // the sync writes an existing ticket again (new name): the old text must be gone
        dao.putTicket(ticket("1", "ABCDE12345", "Erika Neumann"))
        assertEquals(emptyList<String>(), ids("mustermann"))
        assertEquals(listOf("1"), ids("neumann"))
        // upserting many existing rows (a delta page) keeps one index entry per ticket
        repeat(3) { dao.putTickets(listOf(ticket("1", "ABCDE12345", "Erika Neumann"))) }
        assertEquals(listOf("1"), ids("neumann"))
        dao.deleteCleanTickets()
        assertEquals(emptyList<String>(), ids("erika"))
        // rowids are reused after deletes: inserting again must not clash with a stale index entry
        dao.putTickets(listOf(ticket("5", "ABCDE55555", "Fresh Name")))
        assertEquals(listOf("5"), ids("fresh"))
    }

    @Test
    fun `valid tickets come before cancelled ones within a rank`() = runBlocking {
        dao.putTickets(listOf(ticket("1", "AAAAA00001", "Max Muster", status = "CANCELLED"), ticket("2", "AAAAA00002", "Max Muster")))
        assertEquals(listOf("2", "1"), ids("muster"))
    }

    // ─── benchmark ───

    private val first = listOf("Max", "Erika", "Jörg", "Anna", "Lukas", "Sophie", "Jonas", "Mia", "Leon", "Emma", "Paul", "Hannah", "Felix", "Laura", "Tim")
    private val last = listOf(
        "Mustermann", "Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann",
        "Koch", "Richter", "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann", "Braun",
    )
    private val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    private fun codeOf(n: Int): String {
        var x = n.toLong() * 2_654_435_761L + 12345
        return buildString { repeat(10) { append(alphabet[(x % alphabet.length).toInt()]); x = x / alphabet.length + n + it } }
    }

    private fun legacy(eventId: String, token: String): Int {
        val norm = org.tix.checkin.core.TicketCode.normalize(token)
        val sql = "SELECT * FROM tickets WHERE eventId = ? AND (attendeeName LIKE '%' || ? || '%' " +
            "OR ticketCode LIKE '%' || ? || '%' OR sectionLabel LIKE '%' || ? || '%' " +
            "OR rowLabel LIKE '%' || ? || '%' OR seatLabel LIKE '%' || ? || '%') " +
            "ORDER BY (status = 'VALID') DESC, attendeeName LIMIT 400"
        return db.openHelper.readableDatabase.query(SimpleSQLiteQuery(sql, arrayOf(eventId, token, norm, token, token, token))).use { c ->
            // read every column of every row, like mapping the entities does
            var n = 0
            while (c.moveToNext()) { for (i in 0 until c.columnCount) if (!c.isNull(i)) c.getString(i); n++ }
            n
        }
    }

    @Test
    fun `benchmark 20k tickets - legacy LIKE vs full text`() = runBlocking {
        val rows = (0 until 20_000).map {
            ticket(
                "id-$it", codeOf(it), "${first[it % first.size]} ${last[(it / first.size) % last.size]}",
                section = if (it % 3 == 0) "Stalls" else "Balcony", row = ('A' + it % 20).toString(), seat = (it % 40 + 1).toString(),
            )
        }
        rows.chunked(500).forEach { dao.putTickets(it) }
        val queries = listOf("mustermann", "schr", "max mus", "stalls b 7", codeOf(777).lowercase(), codeOf(777).take(6).lowercase(), "ma", "zim")

        fun median(block: () -> Unit): Double {
            repeat(3) { block() } // warm-up
            val times = (1..15).map { val t = System.nanoTime(); block(); (System.nanoTime() - t) / 1e6 }.sorted()
            return times[times.size / 2]
        }
        println("search benchmark, 20000 tickets (median of 15 runs, ms): query | legacy LIKE (400 rows read) | new (DB + filter + rank, 50 rows)")
        var legacyTotal = 0.0
        var newTotal = 0.0
        for (q in queries) {
            val oldMs = median { legacy("ev1", LocalSearchTokenLongest.of(q)) }
            val newMs = median { runBlocking { search.search("ev1", q) } }
            legacyTotal += oldMs
            newTotal += newMs
            println("  %-14s | %8.2f | %8.2f   (hits: %d)".format(q, oldMs, newMs, runBlocking { search.search("ev1", q).size }))
        }
        println("  total          | %8.2f | %8.2f".format(legacyTotal, newTotal))
        // Sanity (not a timing assertion that could flake): the new path finds what the user typed.
        assertTrue(runBlocking { search.search("ev1", codeOf(777)) }.first().id == "id-777")
        assertTrue(runBlocking { search.search("ev1", "mustermann") }.isNotEmpty())
    }

    private object LocalSearchTokenLongest {
        fun of(q: String) = org.tix.checkin.core.scan.LocalSearch.tokens(q).maxBy { it.length }
    }
}
