package org.tix.checkin.core.lan

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

private const val MAX_LINE = 8 * 1024
private const val MAX_HEADERS = 40
private const val CHUNK = 8 * 1024

/** Largest request body the master accepts (a push of 50 scans is far below). */
const val LAN_MAX_REQUEST_BYTES = 1024 * 1024

/** Largest answer body a client accepts. */
const val LAN_MAX_RESPONSE_BYTES = 1024 * 1024

private fun readLine(input: InputStream): String? {
    val out = ByteArrayOutputStream()
    while (true) {
        val b = input.read()
        if (b < 0) return if (out.size() == 0) null else throw IOException("unexpected end of stream")
        if (b == '\n'.code) break
        if (out.size() >= MAX_LINE) throw IOException("line too long")
        if (b != '\r'.code) out.write(b)
    }
    return out.toString(Charsets.ISO_8859_1)
}

private fun readHeaders(input: InputStream): Map<String, String> {
    val headers = HashMap<String, String>()
    while (true) {
        val line = readLine(input) ?: throw IOException("unexpected end of headers")
        if (line.isEmpty()) return headers
        if (headers.size >= MAX_HEADERS) throw IOException("too many headers")
        val i = line.indexOf(':')
        if (i <= 0) throw IOException("bad header")
        headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
    }
}

/**
 * Reads exactly [length] bytes in small chunks: the buffer grows with the bytes that really arrive, so a
 * peer announcing a huge `Content-Length` and sending nothing costs no memory.
 */
internal fun readBody(input: InputStream, length: Int): ByteArray {
    val out = ByteArrayOutputStream(minOf(length, CHUNK))
    val buf = ByteArray(CHUNK)
    var remaining = length
    while (remaining > 0) {
        val n = input.read(buf, 0, minOf(buf.size, remaining))
        if (n < 0) throw IOException("body truncated")
        out.write(buf, 0, n)
        remaining -= n
    }
    return out.toByteArray()
}

private fun reason(status: Int) = when (status) {
    200 -> "OK"
    400 -> "Bad Request"
    401 -> "Unauthorized"
    404 -> "Not Found"
    413 -> "Payload Too Large"
    else -> "Error"
}

/**
 * Which peers may even talk to the master: loopback, private IPv4 (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16, fe80::/10) and IPv6 unique-local (fc00::/7). Anything else - e.g. a global IPv6 address reaching
 * the phone over mobile data - is dropped before it takes a connection slot.
 */
object LanSourcePolicy {
    /** Key for per-source limits: the address, but IPv6 peers by their /64 prefix (one host owns a whole /64). */
    fun sourceKey(address: InetAddress): String {
        if (address is Inet6Address) {
            val b = address.address
            if (!(b.size == 16 && (0..9).all { b[it].toInt() == 0 } && b[10] == 0xFF.toByte() && b[11] == 0xFF.toByte())) {
                return "v6:" + b.copyOf(8).joinToString("") { "%02x".format(it) }
            }
        }
        return address.hostAddress.substringBefore('%')
    }

    fun isLanSource(address: InetAddress): Boolean {
        // A dual-stack socket may report an IPv4 peer as ::ffff:a.b.c.d (an Inet6Address): classify the embedded IPv4 address.
        if (address is Inet6Address) {
            val b = address.address
            if (b.size == 16 && (0..9).all { b[it].toInt() == 0 } && b[10] == 0xFF.toByte() && b[11] == 0xFF.toByte()) {
                return isLanSource(InetAddress.getByAddress(b.copyOfRange(12, 16)))
            }
        }
        if (address.isAnyLocalAddress) return false
        if (address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress) return true
        if (address is Inet6Address) return (address.address[0].toInt() and 0xFE) == 0xFC // fc00::/7
        return false
    }
}

/**
 * Minimal HTTP/1.1 server for the LAN master: one request per connection (`Connection: close`),
 * `POST` with `Content-Length` only. Everything of substance happens in the encrypted envelope
 * ([LanRequestProcessor]); this class only frames bytes. Plain `java.net` sockets: no extra library,
 * runs unchanged on the JVM (tests) and Android.
 *
 * Hardening: only LAN source addresses ([LanSourcePolicy]) get a slot, at most [maxPerIp] connections per
 * source address and [maxConnections] overall, every phase of a connection (reading the request, writing the
 * answer) has a hard [deadlineMillis] enforced by a timer that closes the socket, bodies are read
 * incrementally and capped at [LAN_MAX_REQUEST_BYTES].
 */
class LanHttpServer(
    private val processor: LanRequestProcessor,
    private val port: Int,
    private val bindAddress: InetAddress? = null,
    private val maxConnections: Int = 32,
    private val maxPerIp: Int = 4,
    private val deadlineMillis: Long = 3_000,
    private val sourceAllowed: (InetAddress) -> Boolean = LanSourcePolicy::isLanSource,
    /** Slots only sources that authenticated recently may use: unauthenticated peers cannot fill the server. */
    private val reservedSlots: Int = maxConnections / 4,
    private val trustMillis: Long = 5 * 60_000L,
) {
    private var socket: ServerSocket? = null
    private var scope: CoroutineScope? = null
    private val slots = Semaphore(maxConnections - reservedSlots)
    private val reserved = Semaphore(reservedSlots)
    private val trusted = ConcurrentHashMap<String, Long>()

    private fun isTrusted(key: String): Boolean {
        val at = trusted[key] ?: return false
        if (System.currentTimeMillis() - at > trustMillis) { trusted.remove(key); return false }
        return true
    }
    private val perIp = ConcurrentHashMap<String, AtomicInteger>()

    val isRunning: Boolean get() = socket?.isClosed == false

    /** Connections currently being served (tests, diagnostics). */
    val activeConnections: Int get() = maxConnections - slots.availablePermits() - reserved.availablePermits()

    /** Starts listening and returns the bound port (useful with port 0). */
    @Synchronized
    fun start(): Int {
        socket?.let { if (!it.isClosed) return it.localPort }
        scope?.cancel() // a dead previous run (accept failure): drop what is left of it
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(bindAddress, port), 50)
        socket = s
        // Nothing may escape a connection coroutine: on Android an uncaught exception would end the process.
        val sc = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })
        scope = sc
        Thread({ acceptLoop(s, sc) }, "tix-lan-accept").apply { isDaemon = true }.start()
        return s.localPort
    }

    @Synchronized
    fun stop() {
        runCatching { socket?.close() }
        socket = null
        scope?.cancel()
        scope = null
    }

    private fun acceptLoop(server: ServerSocket, sc: CoroutineScope) {
        while (!server.isClosed) {
            val client = try {
                server.accept()
            } catch (_: IOException) {
                // Closed by stop(), or the listener broke: close it so isRunning turns false and the owner restarts.
                runCatching { server.close() }
                return
            }
            admit(client, sc)
        }
    }

    private fun admit(client: Socket, sc: CoroutineScope) {
        val address = client.inetAddress
        if (address == null || !sourceAllowed(address)) {
            runCatching { client.close() }
            return
        }
        val ip = LanSourcePolicy.sourceKey(address)
        // General slots first; a source that authenticated recently may also use the reserved ones.
        val pool = when {
            slots.tryAcquire() -> slots
            isTrusted(ip) && reserved.tryAcquire() -> reserved
            else -> null
        }
        if (pool == null) {
            runCatching { client.close() }
            return
        }
        val counter = perIp.computeIfAbsent(ip) { AtomicInteger() }
        if (counter.incrementAndGet() > maxPerIp) {
            counter.decrementAndGet()
            pool.release()
            runCatching { client.close() }
            return
        }
        val released = AtomicBoolean(false)
        val job = sc.launch { serve(client, ip) }
        // Runs however the job ends - also when it was cancelled before its first line ever ran.
        job.invokeOnCompletion {
            runCatching { client.close() }
            if (released.compareAndSet(false, true)) {
                if (counter.decrementAndGet() <= 0) perIp.remove(ip, counter)
                pool.release()
            }
        }
    }

    private suspend fun serve(client: Socket, ip: String) {
        try {
            client.soTimeout = deadlineMillis.toInt()
            val request = withDeadline(client) { readRequest(client) }
            val response = when (request) {
                is Request.Bad -> WireResponse(request.status)
                is Request.Ok -> processor.process(request.method, request.path, request.headers, request.body)
                    .also { if (it.status == 200) trusted[ip] = System.currentTimeMillis() }
                null -> return
            }
            withDeadline(client) { write(client, response) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: IOException) {
            // malformed / timed-out peer: drop the connection
        } catch (_: Throwable) {
            // A bug in a handler must not leak the slot or kill the process: answer 500 if the peer still listens.
            runCatching { withDeadline(client) { write(client, WireResponse(500)) } }
        }
    }

    private sealed interface Request {
        class Ok(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray) : Request
        class Bad(val status: Int) : Request
    }

    private fun readRequest(client: Socket): Request? {
        val input = BufferedInputStream(client.getInputStream())
        val requestLine = readLine(input) ?: return null
        val parts = requestLine.split(' ')
        if (parts.size < 3) return Request.Bad(400)
        val headers = readHeaders(input)
        if (headers.containsKey("transfer-encoding")) return Request.Bad(400)
        val length = headers["content-length"]?.let { it.toLongOrNull() ?: return Request.Bad(400) } ?: 0L
        if (length < 0) return Request.Bad(400)
        if (length > LAN_MAX_REQUEST_BYTES) return Request.Bad(413)
        val body = readBody(input, length.toInt())
        return Request.Ok(parts[0], parts[1].substringBefore('?'), headers, body)
    }

    /** Runs a blocking socket phase under a hard deadline: when it expires the timer closes the socket. */
    private fun <T> withDeadline(client: Socket, block: () -> T): T {
        val task = timer.schedule({ runCatching { client.close() } }, deadlineMillis, TimeUnit.MILLISECONDS)
        try {
            return block()
        } finally {
            task.cancel(false)
        }
    }

    private fun write(client: Socket, r: WireResponse) {
        val out = client.getOutputStream()
        val head = StringBuilder("HTTP/1.1 ${r.status} ${reason(r.status)}\r\n")
        head.append("Content-Type: application/octet-stream\r\n")
        head.append("Content-Length: ${r.body.size}\r\nConnection: close\r\n")
        for ((k, v) in r.headers) head.append(k).append(": ").append(v).append("\r\n")
        head.append("\r\n")
        out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(r.body)
        out.flush()
    }

    private companion object {
        val timer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "tix-lan-deadline").apply { isDaemon = true }
        }
    }
}

/**
 * [LanWire] over plain sockets with a hard overall deadline (no OkHttp: never carries the server token). The
 * deadline also holds against a peer that trickles bytes: when it expires the coroutine is cancelled and a
 * cancellation handler closes the socket, which ends the blocked read.
 */
class LanHttpClient : LanWire {
    override suspend fun post(
        host: String,
        port: Int,
        path: String,
        headers: Map<String, String>,
        body: ByteArray,
        timeoutMillis: Long,
    ): WireResponse = try {
        withTimeout(timeoutMillis) {
            withContext(Dispatchers.IO) {
                val socket = Socket()
                coroutineScope {
                    // Blocking socket calls ignore cancellation: this watcher closes the socket when the coroutine is
                    // cancelled (deadline hit, caller gave up), which ends the blocked read with an IOException.
                    val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            awaitCancellation()
                        } finally {
                            runCatching { socket.close() }
                        }
                    }
                    try {
                        exchange(socket, host, port, path, headers, body, timeoutMillis)
                    } finally {
                        watcher.cancel()
                    }
                }
            }
        }
    } catch (e: TimeoutCancellationException) {
        throw LanNetworkException("LAN request timed out", e)
    }

    private fun exchange(socket: Socket, host: String, port: Int, path: String, headers: Map<String, String>, body: ByteArray, timeoutMillis: Long): WireResponse {
        val deadline = System.nanoTime() + timeoutMillis * 1_000_000
        fun remaining(): Int {
            val ms = (deadline - System.nanoTime()) / 1_000_000
            if (ms <= 0) throw SocketTimeoutException("LAN request timed out")
            return ms.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        }
        try {
            socket.use { s ->
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(host, port), remaining())
                s.soTimeout = remaining()
                val out = s.getOutputStream()
                val authority = (if (host.contains(':') && !host.startsWith("[")) "[$host]" else host) + ":$port"
                val head = StringBuilder("POST $path HTTP/1.1\r\n" + "Host: $authority" + "\r\n")
                head.append("Content-Type: application/octet-stream" + "\r\n" + "Content-Length: ${body.size}" + "\r\n" + "Connection: close" + "\r\n")
                for ((k, v) in headers) head.append(k).append(": ").append(v).append("\r\n")
                head.append("\r\n")
                out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
                out.write(body)
                out.flush()
                val input = BufferedInputStream(s.getInputStream())
                s.soTimeout = remaining()
                val status = readLine(input)?.split(' ')?.getOrNull(1)?.toIntOrNull() ?: throw IOException("bad status line")
                val h = readHeaders(input)
                val length = h["content-length"]?.toLongOrNull() ?: 0L
                if (length < 0 || length > LAN_MAX_RESPONSE_BYTES) throw IOException("response too large")
                s.soTimeout = remaining()
                return WireResponse(status, h, readBody(input, length.toInt()))
            }
        } catch (e: IOException) {
            throw LanNetworkException(e.message ?: "LAN request failed", e)
        }
    }
}
