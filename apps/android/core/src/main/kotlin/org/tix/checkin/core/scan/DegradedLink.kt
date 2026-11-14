package org.tix.checkin.core.scan

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout

/**
 * "Slow or unreachable server" state machine of the scan path. After a scan (or any request) timed out or failed to
 * connect, the link is DEGRADED: scans skip the server (no per-scan wait) and go to the LAN master / this device.
 * Only a background probe that answers within [probeTimeoutMillis] restores it - a slow-but-alive sync request must
 * not, or the next scan would pay the timeout again (flapping).
 *
 * The probe is scheduled with an exponential backoff: [initialBackoffMillis], doubling per failed probe up to
 * [maxBackoffMillis]; a success resets it. Pure logic (clock injected), no coroutines of its own.
 */
class DegradedLink(
    private val now: () -> Long = System::currentTimeMillis,
    private val initialBackoffMillis: Long = 30_000,
    private val maxBackoffMillis: Long = 300_000,
    val probeTimeoutMillis: Long = 1_500,
) {
    private var nextBackoff = initialBackoffMillis
    private var probeAt = 0L

    @Volatile
    var degraded = false
        private set

    /** Milliseconds until the next probe is due while degraded (0 = due now). */
    @Synchronized
    fun millisUntilProbe(): Long = if (degraded) (probeAt - now()).coerceAtLeast(0) else 0

    /** A request to the server timed out / could not connect. No effect while already degraded. */
    @Synchronized
    fun onSlowOrUnreachable() {
        if (degraded) return
        degraded = true
        schedule()
    }

    /** The probe answered in time: back to normal, backoff reset. */
    @Synchronized
    fun onProbeSuccess() {
        degraded = false
        nextBackoff = initialBackoffMillis
        probeAt = 0
    }

    /** The probe failed or was too slow: wait longer for the next one. */
    @Synchronized
    fun onProbeFailure() {
        if (!degraded) return
        schedule()
    }

    /** Forget everything (network lost / paired again). */
    @Synchronized
    fun reset() = onProbeSuccess()

    private fun schedule() {
        probeAt = now() + nextBackoff
        nextBackoff = (nextBackoff * 2).coerceAtMost(maxBackoffMillis)
    }

    /**
     * Runs [probe] if one is due. Returns true = restored, false = still degraded (probe failed or too slow),
     * null = nothing to do (not degraded / not due yet).
     */
    suspend fun probeIfDue(probe: suspend () -> Unit): Boolean? {
        if (!degraded || millisUntilProbe() > 0) return null
        return try {
            withTimeout(probeTimeoutMillis) { probe() }
            onProbeSuccess()
            true
        } catch (e: TimeoutCancellationException) {
            onProbeFailure()
            false
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Only a cancelled caller scope ends the probe loop; a cancellation raised inside the probe request while
            // the scope is alive is just a failed probe (otherwise the loop would die and the link stay degraded).
            currentCoroutineContext().ensureActive()
            onProbeFailure()
            false
        } catch (e: Exception) {
            onProbeFailure()
            false
        }
    }
}
