package org.tix.checkin.data

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        DeviceConfigEntity::class, EventEntity::class, KeyEntity::class, TicketTypeEntity::class,
        CategoryEntity::class, EntranceEntity::class, SectionEntity::class, SyncStateEntity::class,
        TicketEntity::class, JournalEntity::class, LanStateEntity::class,
    ],
    version = 2,
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

/** Every migration, in one place: the app and the migration test both use this list. Never add a destructive fallback. */
val ALL_MIGRATIONS: Array<Migration> = arrayOf(MIGRATION_1_2)
