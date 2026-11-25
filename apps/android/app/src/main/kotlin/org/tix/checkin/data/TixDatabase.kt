package org.tix.checkin.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import org.tix.checkin.core.scan.LocalSearch

@Database(
    entities = [
        DeviceConfigEntity::class, EventEntity::class, KeyEntity::class, TicketTypeEntity::class,
        CategoryEntity::class, EntranceEntity::class, SectionEntity::class, SyncStateEntity::class,
        TicketEntity::class, JournalEntity::class, LanStateEntity::class, TicketFtsEntity::class, LanScanAnswerEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
abstract class TixDatabase : RoomDatabase() {
    abstract fun dao(): TixDao
}

/**
 * v1 -> v2: result colours of the manifest. One nullable TEXT column without default (exactly what Room derives from
 * `resultStyleJson: String? = null`). The stored manifest ETag is cleared so the next sync fetches the manifest again
 * even when the server did not change since the old app version ignored the colour fields. The unsent scan journal
 * is untouched; there is no destructive fallback anywhere.
 */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE device_config ADD COLUMN resultStyleJson TEXT")
        db.execSQL("UPDATE device_config SET manifestEtag = NULL")
    }
}

/**
 * v2 -> v3: manual attendee search. Adds the order number and the folded `searchText` column to `tickets`, fills
 * `searchText` from the existing rows in Kotlin ([LocalSearch.indexText]; SQL cannot fold ø/ß/accents like the query
 * side), then creates the content-backed FTS4 table over it plus Room's four content-sync triggers exactly as in
 * schema 3.json and fills the index (`rebuild` reads the content table). The triggers are created AFTER the column
 * fill, so the fill does not touch the (not yet existing) index.
 *
 * The sync cursors are reset (not the tickets): the next sync delivers every ticket again and fills in the order
 * numbers the old rows lack, while search keeps working on the existing rows meanwhile. Unsent scans are safe.
 */
val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `tickets` ADD COLUMN `orderNumber` TEXT")
        db.execSQL("ALTER TABLE `tickets` ADD COLUMN `searchText` TEXT NOT NULL DEFAULT ''")
        fillSearchText(db)
        db.execSQL(
            "CREATE VIRTUAL TABLE IF NOT EXISTS `tickets_fts` USING FTS4(`searchText` TEXT NOT NULL, tokenize=unicode61, content=`tickets`)",
        )
        db.execSQL("CREATE TRIGGER IF NOT EXISTS room_fts_content_sync_tickets_fts_BEFORE_UPDATE BEFORE UPDATE ON `tickets` BEGIN DELETE FROM `tickets_fts` WHERE `docid`=OLD.`rowid`; END")
        db.execSQL("CREATE TRIGGER IF NOT EXISTS room_fts_content_sync_tickets_fts_BEFORE_DELETE BEFORE DELETE ON `tickets` BEGIN DELETE FROM `tickets_fts` WHERE `docid`=OLD.`rowid`; END")
        db.execSQL("CREATE TRIGGER IF NOT EXISTS room_fts_content_sync_tickets_fts_AFTER_UPDATE AFTER UPDATE ON `tickets` BEGIN INSERT INTO `tickets_fts`(`docid`, `searchText`) VALUES (NEW.`rowid`, NEW.`searchText`); END")
        db.execSQL("CREATE TRIGGER IF NOT EXISTS room_fts_content_sync_tickets_fts_AFTER_INSERT AFTER INSERT ON `tickets` BEGIN INSERT INTO `tickets_fts`(`docid`, `searchText`) VALUES (NEW.`rowid`, NEW.`searchText`); END")
        db.execSQL("INSERT INTO `tickets_fts`(`tickets_fts`) VALUES('rebuild')")
        // Full re-delivery of the tickets on the next sync (order numbers); equal syncVersion rows are taken over.
        db.execSQL("UPDATE `sync_state` SET `cursor` = NULL")
    }

    private fun fillSearchText(db: SupportSQLiteDatabase) {
        class Row(val rowId: Long, val text: String)
        val rows = ArrayList<Row>()
        db.query("SELECT `rowid`, `attendeeName`, `ticketCode`, `sectionLabel`, `rowLabel`, `seatLabel` FROM `tickets`").use { c ->
            while (c.moveToNext()) {
                rows += Row(
                    c.getLong(0),
                    LocalSearch.indexText(
                        c.getStringOrNull(1), c.getStringOrNull(2).orEmpty(), c.getStringOrNull(3).orEmpty(),
                        c.getStringOrNull(4), c.getStringOrNull(5), null,
                    ),
                )
            }
        }
        val update = db.compileStatement("UPDATE `tickets` SET `searchText` = ? WHERE `rowid` = ?")
        try {
            for (r in rows) {
                update.bindString(1, r.text)
                update.bindLong(2, r.rowId)
                update.executeUpdateDelete()
            }
        } finally {
            update.close()
        }
    }

    private fun android.database.Cursor.getStringOrNull(i: Int): String? = if (isNull(i)) null else getString(i)
}

/**
 * v3 -> v4: persistent idempotency table of the LAN master (`lan_scan_answers`). New table only (SQL as in schema 4.json);
 * nothing existing is touched.
 */
val MIGRATION_3_4 = object : Migration(3, 4) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `lan_scan_answers` (`seq` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`answerKey` TEXT NOT NULL, `response` TEXT NOT NULL, `createdAt` INTEGER NOT NULL)",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_lan_scan_answers_answerKey` ON `lan_scan_answers` (`answerKey`)")
    }
}

/** Every migration, in one place: the app and the migration test both use this list. Never add a destructive fallback. */
val ALL_MIGRATIONS: Array<Migration> = arrayOf(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
