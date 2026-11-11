package org.tix.checkin.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.scan.ServerLink

enum class Connection { ONLINE, OFFLINE, MAINTENANCE }

/**
 * Reachability of the server as seen by the app: fed by every request (see [ServerLink]) and by the
 * system's connectivity callback. While not [Connection.ONLINE] scans are decided locally without
 * even trying the server; the sync loop probes the server and flips the state back.
 */
class ConnectionMonitor(context: Context) : ServerLink {
    private val _state = MutableStateFlow(Connection.ONLINE)
    val state: StateFlow<Connection> = _state

    private val _wake = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Emits when the network came back: the sync loop should not wait for its next tick. */
    val wake: SharedFlow<Unit> = _wake

    @Volatile
    private var networkAvailable = true

    /** Called on 401 (token invalid / device revoked). */
    @Volatile
    var onUnauthorized: (() -> Unit)? = null

    init {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    networkAvailable = true
                    _wake.tryEmit(Unit)
                }

                override fun onLost(network: Network) {
                    networkAvailable = false
                    _state.value = Connection.OFFLINE
                }
            },
        )
    }

    override fun isUsable() = networkAvailable && _state.value == Connection.ONLINE

    override fun onSuccess() {
        _state.value = Connection.ONLINE
    }

    override fun onFailure(error: Throwable) {
        if (error is ApiException) {
            if (error.isUnauthorized) onUnauthorized?.invoke()
            // 429 means the server is alive: only back off, stay online.
            if (error.status == 429) return
            _state.value = if (error.isMaintenance) Connection.MAINTENANCE else Connection.OFFLINE
        } else {
            _state.value = Connection.OFFLINE
        }
    }
}
