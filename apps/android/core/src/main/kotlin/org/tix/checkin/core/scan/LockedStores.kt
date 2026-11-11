package org.tix.checkin.core.scan

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.lan.LanClientStore
import org.tix.checkin.core.lan.LanTicketState
import org.tix.checkin.core.sync.JournalUploadStore
import org.tix.checkin.core.sync.TicketSyncStore

/*
 * Every read-modify-write of a ticket row happens under the shared database lock (dbLock): scans
 * (decide + commit in one critical section, see the authorities), delta pages, upload outcomes and LAN
 * states. Lock order is always "mutex first, then the Room transaction", and nothing waits for another lock
 * while holding this one. These wrappers lock only the store write, never the network call around it - the
 * LAN master has an 800 ms scan budget.
 *
 * ScanStore.commit / LanMasterStore.commitLan are NOT wrapped: their callers already hold the lock (the
 * mutex is not reentrant).
 */

/** Delta pages are merged and written under [lock]. */
class LockedTicketSyncStore(private val inner: TicketSyncStore, private val lock: Mutex) : TicketSyncStore {
    override suspend fun cursor(eventId: String) = inner.cursor(eventId)
    override suspend fun applyPage(eventId: String, page: SyncPage) = lock.withLock { inner.applyPage(eventId, page) }
}

/** Upload outcomes and quarantine write ticket rows: under [lock]. */
class LockedJournalUploadStore(private val inner: JournalUploadStore, private val lock: Mutex) : JournalUploadStore {
    override suspend fun pending(limit: Int) = inner.pending(limit)

    override suspend fun applyOutcome(entry: JournalEntry, outcome: ScanOutcome) =
        lock.withLock { inner.applyOutcome(entry, outcome) }

    override suspend fun quarantine(entry: JournalEntry, error: String) =
        lock.withLock { inner.quarantine(entry, error) }

    override suspend fun requeueQuarantined(appVersion: Int) = lock.withLock { inner.requeueQuarantined(appVersion) }
}

/** LAN states from the master are merged into ticket rows: under [lock]. */
class LockedLanClientStore(private val inner: LanClientStore, private val lock: Mutex) : LanClientStore by inner {
    override suspend fun applyStates(states: List<LanTicketState>) = lock.withLock { inner.applyStates(states) }
}
