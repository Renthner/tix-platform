package org.tix.checkin.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.tix.checkin.core.scan.ServerLink
import org.tix.checkin.core.scan.ServerLinkTracker

typealias Connection = org.tix.checkin.core.scan.Connection

/**
 * Reachability of the server as seen by the app: fed by every request (see [ServerLink]) and by the
 * system's connectivity callback. While not [Connection.ONLINE] scans are decided locally without
 * even trying the server; the sync loop probes the server and flips the state back.
 */
class ConnectionMonitor(context: Context) : ServerLink {
    private val tracker = ServerLinkTracker()
    val state: StateFlow<Connection> = tracker.state

    private val _wake = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Emits when the network came back: the sync loop should not wait for its next tick. */
    val wake: SharedFlow<Unit> = _wake

    /** Called on 401 (token invalid / device revoked). */
    var onUnauthorized: (() -> Unit)?
        get() = tracker.unauthorizedHandler
        set(value) { tracker.unauthorizedHandler = value }

    init {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    tracker.onNetworkAvailable()
                    _wake.tryEmit(Unit)
                }

                override fun onLost(network: Network) {
                    tracker.onNetworkLost()
                }
            },
        )
    }

    override fun isUsable() = tracker.isUsable()
    override fun onSuccess() = tracker.onSuccess()
    override fun onFailure(error: Throwable) = tracker.onFailure(error)

    /**
     * Background probe while DEGRADED: sleeps until the backoff window ends, then runs [call] (a cheap request) with
     * the scan timeout; success restores ONLINE, failure doubles the window. Runs for the life of [scope].
     */
    fun startProbe(scope: CoroutineScope, call: suspend () -> Unit) {
        scope.launch {
            while (true) {
                if (tracker.state.value != Connection.DEGRADED) {
                    tracker.state.first { it == Connection.DEGRADED }
                    continue
                }
                val wait = tracker.degraded.millisUntilProbe()
                if (wait > 0) {
                    // Wake early when the state leaves DEGRADED (network lost, hard error).
                    withTimeoutOrNull(wait) { tracker.state.first { it != Connection.DEGRADED } }
                    continue
                }
                tracker.probe(call)
            }
        }
    }
}
