package org.tix.checkin.data

import android.content.ContentValues
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Real installs hold unsent scans: migrations must keep every row. The schema files in app/schemas are the
 * reference for each released version (1.json = 1.0.0-alpha.1/2).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TixMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), TixDatabase::class.java)

    private val tables = listOf(
        "device_config", "events", "event_keys", "ticket_types", "categories", "entrances", "sections",
        "sync_state", "tickets", "scan_journal", "lan_state",
    )

    /** Inserts one row per table, filling every column from the table's own definition (NOT NULL or not). */
    private fun insertSampleRows(db: SupportSQLiteDatabase) {
        for (table in tables) {
            val values = ContentValues()
            db.query("PRAGMA table_info(`$table`)").use { c ->
                while (c.moveToNext()) {
                    val name = c.getString(c.getColumnIndexOrThrow("name"))
                    val type = c.getString(c.getColumnIndexOrThrow("type")).uppercase()
                    when {
                        name == "id" && table == "device_config" -> values.put(name, 1)
                        type.contains("INT") -> values.put(name, 1)
                        type.contains("REAL") -> values.put(name, 1.5)
                        else -> values.put(name, "v-$table-$name")
                    }
                }
            }
            val id = db.insert(table, 0, values)
            assertTrue("insert into $table failed", id != -1L)
        }
    }

    private fun count(db: SupportSQLiteDatabase, table: String): Int =
        db.query("SELECT COUNT(*) FROM `$table`").use { it.moveToFirst(); it.getInt(0) }

    @Test
    fun migration1To2KeepsAllRows() {
        helper.createDatabase(dbName, 1).use { insertSampleRows(it) }

        val db = helper.runMigrationsAndValidate(dbName, 2, true, MIGRATION_1_2)

        for (table in tables) assertEquals("rows in $table", 1, count(db, table))
        db.query("SELECT uploaded, clientScanId, ticketId FROM scan_journal").use {
            assertTrue(it.moveToFirst())
            assertEquals(1, it.getInt(0))
            assertEquals("v-scan_journal-clientScanId", it.getString(1))
            assertEquals("v-scan_journal-ticketId", it.getString(2))
        }
        db.query("SELECT manifestEtag, resultStyleJson FROM device_config").use {
            assertTrue(it.moveToFirst())
            assertTrue("manifest ETag is cleared so the next sync refetches", it.isNull(0))
            assertTrue(it.isNull(1))
        }
        db.query("SELECT tokenCipher FROM device_config").use { assertTrue(it.moveToFirst()) }
    }

    private fun insertTicket(db: SupportSQLiteDatabase, id: String, code: String, name: String?, section: String, row: String, seat: String) {
        val v = ContentValues()
        v.put("id", id); v.put("ticketCode", code); v.put("status", "VALID"); v.put("eventId", "ev1"); v.put("keyId", "k1")
        v.put("sectionId", "s"); v.put("sectionLabel", section); v.put("rowLabel", row); v.put("seatLabel", seat)
        v.put("categoryId", "c"); v.put("categoryName", "Cat"); v.put("ticketTypeId", "t"); v.put("attendeeName", name)
        v.put("checkInState", "NONE"); v.put("checkInCount", 0); v.put("additionalPaymentOpen", 0); v.put("syncVersion", 1)
        v.put("provisional", 0); v.put("localDirty", 0)
        // v3 added searchText (NOT NULL): present only when the table has it
        db.query("PRAGMA table_info(`tickets`)").use { c ->
            while (c.moveToNext()) {
                if (c.getString(c.getColumnIndexOrThrow("name")) == "searchText") {
                    v.put("searchText", org.tix.checkin.core.scan.LocalSearch.indexText(name, code, section, row, seat, null))
                }
            }
        }
        assertTrue(db.insert("tickets", 0, v) != -1L)
    }

    private fun ftsIds(db: SupportSQLiteDatabase, match: String): List<String> =
        db.query("SELECT t.id FROM tickets t JOIN tickets_fts ON t.rowid = tickets_fts.docid WHERE tickets_fts MATCH ? ORDER BY t.id", arrayOf(match)).use {
            buildList { while (it.moveToNext()) add(it.getString(0)) }
        }

    @Test
    fun migration2To3IndexesExistingTicketsAndKeepsAllRows() {
        helper.createDatabase(dbName, 2).use { db ->
            insertSampleRows(db) // one row per table (also a ticket "v-tickets-id")
            insertTicket(db, "t1", "ABCDE12345", "Erika Mustermann", "Stalls", "B", "7")
            insertTicket(db, "t2", "ZZZZZ99999", "Jörg Müller", "Balcony", "A", "12")
            insertTicket(db, "t3", "QQQQQ11111", null, "Balcony", "A", "13")
            insertTicket(db, "t5", "SSSSS55555", "Søren Strauß", "Gallery", "C", "9")
        }

        val db = helper.runMigrationsAndValidate(dbName, 3, true, MIGRATION_1_2, MIGRATION_2_3)

        for (table in tables) assertEquals("rows in $table", if (table == "tickets") 5 else 1, count(db, table))
        // The existing rows are searchable right after the migration (rebuilt from the content table).
        assertEquals(listOf("t1"), ftsIds(db, "muster*"))
        assertEquals(listOf("t2"), ftsIds(db, "muller*")) // diacritics folded
        assertEquals(listOf("t1"), ftsIds(db, "abcde1*"))
        assertEquals(listOf("t2", "t3"), ftsIds(db, "balcony* a*"))
        assertEquals(listOf("t3"), ftsIds(db, "13*"))
        // searchText was filled in Kotlin (folded like the query side): ø/ß are found, not only accents.
        assertEquals(listOf("t5"), ftsIds(db, "soren*"))
        assertEquals(listOf("t5"), ftsIds(db, "strauss*"))
        // The order number column exists (empty for old rows) and a later update is indexed.
        db.query("SELECT orderNumber FROM tickets WHERE id = 't1'").use { assertTrue(it.moveToFirst()); assertTrue(it.isNull(0)) }
        db.execSQL("UPDATE tickets SET orderNumber = 'TIX-2026-000123', searchText = searchText || ' tix 2026 000123' WHERE id = 't1'")
        assertEquals(listOf("t1"), ftsIds(db, "000123"))
        // The next sync delivers every ticket again (cursor reset), the tickets themselves stay searchable meanwhile.
        db.query("SELECT cursor FROM sync_state").use { assertTrue(it.moveToFirst()); assertTrue(it.isNull(0)) }
        // The sync triggers keep it consistent afterwards: update, insert, delete.
        db.execSQL("UPDATE tickets SET attendeeName = 'Anna Neu', searchText = 'anna neu abcde12345 stalls b 7' WHERE id = 't1'")
        assertEquals(emptyList<String>(), ftsIds(db, "muster*"))
        assertEquals(listOf("t1"), ftsIds(db, "neu*"))
        insertTicket(db, "t4", "NEWNEWNEW1", "Max Neumann", "Stalls", "C", "1")
        assertEquals(listOf("t1", "t4"), ftsIds(db, "neu*"))
        db.execSQL("DELETE FROM tickets WHERE id = 't4'")
        assertEquals(listOf("t1"), ftsIds(db, "neu*"))
        // Everything else of the old schema is untouched (unsent scan journal).
        db.query("SELECT clientScanId FROM scan_journal").use {
            assertTrue(it.moveToFirst())
            assertEquals("v-scan_journal-clientScanId", it.getString(0))
        }
    }

    @Test
    fun migration3To4AddsLanAnswersAndKeepsAllRows() {
        helper.createDatabase(dbName, 3).use { db ->
            insertSampleRows(db)
            insertTicket(db, "t1", "ABCDE12345", "Erika Mustermann", "Stalls", "B", "7")
        }

        val db = helper.runMigrationsAndValidate(dbName, 4, true, MIGRATION_3_4)

        for (table in tables) assertEquals("rows in $table", if (table == "tickets") 2 else 1, count(db, table))
        assertEquals(0, count(db, "lan_scan_answers"))
        // the table works as the DAO uses it: unique key, newest rows kept
        db.execSQL("INSERT INTO lan_scan_answers (answerKey, response, createdAt) VALUES ('a/1', '{}', 1)")
        db.execSQL("INSERT OR REPLACE INTO lan_scan_answers (answerKey, response, createdAt) VALUES ('a/1', '{\"x\":1}', 2)")
        assertEquals(1, count(db, "lan_scan_answers"))
        db.query("SELECT response FROM lan_scan_answers WHERE answerKey = 'a/1'").use {
            assertTrue(it.moveToFirst()); assertEquals("{\"x\":1}", it.getString(0))
        }
        // unsent journal untouched
        db.query("SELECT clientScanId FROM scan_journal").use {
            assertTrue(it.moveToFirst()); assertEquals("v-scan_journal-clientScanId", it.getString(0))
        }
    }

    @Test
    fun currentDatabaseOpensThroughRoomWithAllMigrations() {
        helper.createDatabase(dbName, 1).use { insertSampleRows(it) }

        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val room = Room.databaseBuilder(context, TixDatabase::class.java, dbName)
            .addMigrations(*ALL_MIGRATIONS)
            .allowMainThreadQueries()
            .build()
        try {
            // Opening validates the schema against the entities; a query proves the file is usable.
            val rows = room.openHelper.writableDatabase.query("SELECT COUNT(*) FROM scan_journal").use {
                it.moveToFirst(); it.getInt(0)
            }
            assertEquals(1, rows)
        } finally {
            room.close()
        }
    }

    // Absolute path: Room 2.8's driver wrapper rejects a bare name under Robolectric.
    private val dbName: String =
        ApplicationProvider.getApplicationContext<android.content.Context>().getDatabasePath("tix-migration-test.db").absolutePath
}
