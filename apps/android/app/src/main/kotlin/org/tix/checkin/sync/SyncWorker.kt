package org.tix.checkin.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import org.tix.checkin.TixApplication

/** Background upload/sync when the app is not in the foreground (needs a network connection). */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as TixApplication).container
        val result = container.sync.syncOnce()
        // Keeps the release list cache fresh (at most every 6 hours); never blocks or fails the sync.
        val update = container.settings.appUpdate.value
        if (result == SyncResult.Ok && update.source == org.tix.checkin.core.UpdateSource.GITHUB) {
            val repository = container.settings.effectiveRepository()
            if (repository.isNotEmpty()) container.githubUpdates.backgroundCheck(repository, container.settings.effectiveChannel())
        }
        return when (result) {
            SyncResult.Ok, SyncResult.NotPaired, SyncResult.Unpaired -> Result.success()
            is SyncResult.Failed -> Result.retry()
        }
    }
}

object SyncScheduler {
    private const val PERIODIC = "tix-sync-periodic"
    private const val ONE_OFF = "tix-sync-now"
    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Every 15 minutes (WorkManager minimum) while paired. */
    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** As soon as a network is available (after an offline scan was journaled). */
    fun uploadSoon(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(ONE_OFF, ExistingWorkPolicy.KEEP, request)
    }

    fun cancelAll(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(PERIODIC)
        wm.cancelUniqueWork(ONE_OFF)
    }
}
