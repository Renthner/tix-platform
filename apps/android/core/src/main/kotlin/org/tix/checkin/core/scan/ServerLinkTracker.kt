package org.tix.checkin.core.scan

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.NetworkException

enum class Connection {
    ONLINE,

    /** Network lost, or the server answered with an error: scans are decided locally; the sync loop probes. */
    OFFLINE,
    MAINTENANCE,

    /** Server timed out / unreachable on a working network: scans skip the server until a probe is quick again. */
    DEGRADED,
}

/**
 * Platform-independent part of the connection monitor: reachability of the server as seen by the app, fed by every
 * request (see [ServerLink]). While not [Connection.ONLINE] scans never wait for the server. A timeout or connect
 * failure ([NetworkException]) enters DEGRADED (see [DegradedLink]); only [probe] restores it.
 */
class ServerLinkTracker(
    val degraded: DegradedLink = DegradedLink(),
) : ServerLink {
    private val _state = MutableStateFlow(Connection.ONLINE)
    val state: StateFlow<Connection> = _state

    @Volatile
    var networkAvailable = true
        private set

    /** Called on 401/403 (token invalid / device revoked). */
    @Volatile
    var unauthorizedHandler: (() -> Unit)? = null

    fun onNetworkAvailable() {
        networkAvailable = true
    }

    fun onNetworkLost() {
        networkAvailable = false
        degraded.reset()
        _state.value = Connection.OFFLINE
    }

    override fun isUsable() = networkAvailable && _state.value == Connection.ONLINE

    override fun onSuccess() {
        // DEGRADED is left by the probe only: a slow request that happened to succeed must not flap the state.
        _state.update { if (it == Connection.DEGRADED) it else Connection.ONLINE }
    }

    override fun onFailure(error: Throwable) {
        if (error is ApiException) {
            if (error.isUnauthorized) {
                unauthorizedHandler?.invoke()
            }
            // 429 means the server is alive: only back off, stay online.
            if (error.status == 429) return
            setHard(if (error.isMaintenance) Connection.MAINTENANCE else Connection.OFFLINE)
        } else if (error is NetworkException && networkAvailable) {
            // Probe schedule first (idempotent while degraded), then the state: the probe loop wakes on the state and
            // must already find a scheduled probe, otherwise it would spin on "due now".
            degraded.onSlowOrUnreachable()
            _state.value = Connection.DEGRADED
        } else {
            setHard(Connection.OFFLINE)
        }
    }

    private fun setHard(s: Connection) {
        val previous = _state.getAndUpdate { s }
        if (previous == Connection.DEGRADED) degraded.reset()
    }

    /** One probe round (called by the background loop): restores ONLINE when [call] answers within the timeout. */
    suspend fun probe(call: suspend () -> Unit): Boolean? {
        val r = degraded.probeIfDue(call)
        if (r == true) _state.compareAndSet(Connection.DEGRADED, Connection.ONLINE)
        // The probe loop may have been overtaken by a hard state change: keep the machine consistent.
        if (_state.value != Connection.DEGRADED && degraded.degraded) degraded.reset()
        return r
    }
}
