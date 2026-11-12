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
