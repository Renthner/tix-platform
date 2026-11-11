package org.tix.checkin.lan

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import java.net.Inet4Address
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.tix.checkin.core.lan.LAN_SERVICE_TYPE
import org.tix.checkin.core.lan.LanAdvert
import org.tix.checkin.core.lan.LanEndpoint

/** A master seen on the network. */
data class LanFound(val endpoint: LanEndpoint, val advert: LanAdvert)

/**
 * DNS-SD (Android NSD) for the LAN: the master advertises `_tixscan._tcp`, clients browse it. Holds a
 * WifiManager multicast lock while either is active (many devices drop multicast otherwise).
 * Pure plumbing - everything that matters is verified again by the encrypted hello.
 */
class LanNsd(context: Context) {
    private val app = context.applicationContext
    private val nsd = app.getSystemService(NsdManager::class.java)
    private val wifi = app.getSystemService(WifiManager::class.java)
    private val executor = Executors.newSingleThreadExecutor()

    private var multicastLock: WifiManager.MulticastLock? = null
    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null

    private val found = LinkedHashMap<String, LanFound>()
    private val _masters = MutableStateFlow<List<LanFound>>(emptyList())
    val masters: StateFlow<List<LanFound>> = _masters

    // Android < 14: one resolve at a time.
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private val infoCallbacks = HashMap<String, NsdManager.ServiceInfoCallback>()

    @Synchronized
    private fun acquireLock() {
        if (multicastLock == null) {
            multicastLock = wifi?.createMulticastLock("tix-lan")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    @Synchronized
    private fun releaseLockIfIdle() {
        if (registration == null && discovery == null) {
            multicastLock?.let { if (it.isHeld) it.release() }
            multicastLock = null
        }
    }

    // ─── advertise (master) ───

    @Synchronized
    fun register(port: Int, advert: LanAdvert) {
        val m = nsd ?: return
        if (registration != null) return
        acquireLock()
        val info = NsdServiceInfo().apply {
            serviceName = "tix-" + advert.deviceId.take(8)
            serviceType = LAN_SERVICE_TYPE
            setPort(port)
            advert.toAttributes().forEach { (k, v) -> setAttribute(k, v) }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {}
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                synchronized(this@LanNsd) {
                    registration = null
                    releaseLockIfIdle()
                }
            }
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
        }
        registration = listener
        try {
            m.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: RuntimeException) {
            registration = null
            releaseLockIfIdle()
        }
    }

    @Synchronized
    fun unregister() {
        val l = registration ?: return
        registration = null
        try {
            nsd?.unregisterService(l)
        } catch (_: RuntimeException) {
            // already gone
        }
        releaseLockIfIdle()
    }

    // ─── browse (clients) ───

    @Synchronized
    fun startDiscovery() {
        val m = nsd ?: return
        if (discovery != null) return
        acquireLock()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                synchronized(this@LanNsd) {
                    discovery = null
                    releaseLockIfIdle()
                }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onServiceFound(serviceInfo: NsdServiceInfo) = resolve(serviceInfo)
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = lost(serviceInfo.serviceName)
        }
        discovery = listener
        try {
            m.discoverServices(LAN_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: RuntimeException) {
            discovery = null
            releaseLockIfIdle()
        }
    }

    @Synchronized
    fun stopDiscovery() {
        val l = discovery ?: return
        discovery = null
        try {
            nsd?.stopServiceDiscovery(l)
        } catch (_: RuntimeException) {
            // not running
        }
        if (Build.VERSION.SDK_INT >= 34) {
            infoCallbacks.values.forEach { cb -> runCatching { nsd?.unregisterServiceInfoCallback(cb) } }
            infoCallbacks.clear()
        }
        resolveQueue.clear()
        found.clear()
        _masters.value = emptyList()
        releaseLockIfIdle()
    }

    private fun resolve(info: NsdServiceInfo) {
        val m = nsd ?: return
        if (Build.VERSION.SDK_INT >= 34) {
            val name = info.serviceName
            synchronized(this) { if (infoCallbacks.containsKey(name)) return }
            val cb = object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {}
                override fun onServiceUpdated(serviceInfo: NsdServiceInfo) = update(serviceInfo)
                override fun onServiceLost() = lost(name)
                override fun onServiceInfoCallbackUnregistered() {}
            }
            synchronized(this) { infoCallbacks[name] = cb }
            try {
                m.registerServiceInfoCallback(info, executor, cb)
            } catch (_: RuntimeException) {
                synchronized(this) { infoCallbacks.remove(name) }
            }
        } else {
            synchronized(this) { resolveQueue.addLast(info) }
            resolveNext()
        }
    }

    @Suppress("DEPRECATION")
    private fun resolveNext() {
        val m = nsd ?: return
        val next = synchronized(this) {
            if (resolving) return
            val n = resolveQueue.removeFirstOrNull() ?: return
            resolving = true
            n
        }
        try {
            m.resolveService(
                next,
                object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = done()
                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        update(serviceInfo)
                        done()
                    }

                    private fun done() {
                        synchronized(this@LanNsd) { resolving = false }
                        resolveNext()
                    }
                },
            )
        } catch (_: RuntimeException) {
            synchronized(this) { resolving = false }
        }
    }

    @Suppress("DEPRECATION")
    private fun update(info: NsdServiceInfo) {
        val attrs = info.attributes.mapValues { it.value?.toString(Charsets.UTF_8).orEmpty() }
        val advert = LanAdvert.parse(attrs) ?: return
        val address = (
            if (Build.VERSION.SDK_INT >= 34) {
                info.hostAddresses.firstOrNull { it is Inet4Address }
            } else {
                info.host?.takeIf { it is Inet4Address }
            }
            ) ?: return
        val host = address.hostAddress ?: return
        synchronized(this) {
            found[info.serviceName] = LanFound(LanEndpoint(host, info.port, advert.deviceId, advert.name), advert)
            _masters.value = found.values.toList()
        }
    }

    private fun lost(serviceName: String) {
        synchronized(this) {
            found.remove(serviceName)
            _masters.value = found.values.toList()
        }
    }
}
