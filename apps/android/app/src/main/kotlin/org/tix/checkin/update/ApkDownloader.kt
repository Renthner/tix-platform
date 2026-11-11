package org.tix.checkin.update

import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.contentLength
import io.ktor.utils.io.readAvailable
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive
import org.tix.checkin.core.ApkUpdate
import org.tix.checkin.net.ServerUrlRefusedException
import org.tix.checkin.net.TixHttpClient

class UpdateException(val kind: Kind, message: String? = null, cause: Throwable? = null) : Exception(message, cause) {
    enum class Kind { HASH_MISSING, HASH_MISMATCH, NETWORK, HTTP, TOO_LARGE, STORAGE, URL_REFUSED }
}

/**
 * Streams the APK into the app's cache directory and computes its SHA-256 on the way. No credentials are sent: the
 * download link is signed (`GET /app/download?t=`), so the device bearer token never leaves the API calls to the paired
 * server. The URL passes the server address policy in `TixHttpClient` (https, or http in the local network; no redirects).
 *
 * GitHub downloads ([viaGithub]) use a separate client without any credentials and follow redirects by hand
 * ([githubGet]: https only, GitHub host allow-list, at most 5 hops).
 */
class ApkDownloader(cacheDir: File, private val githubUserAgent: String = "tix-checkin") {
    private val dir = File(cacheDir, "updates")

    /** Removes downloaded APKs (partial or complete). */
    fun clean() {
        dir.listFiles()?.forEach { it.delete() }
    }

    /**
     * Returns the verified file. On any failure or cancellation nothing stays on disk.
     * [expectedSha256] blank/malformed -> [UpdateException.Kind.HASH_MISSING] before anything is downloaded.
     */
    suspend fun download(
        url: String,
        expectedSha256: String,
        announcedSizeBytes: Long,
        viaGithub: Boolean = false,
        onProgress: (read: Long, total: Long) -> Unit,
    ): File {
        if (ApkUpdate.normalizeSha256(expectedSha256) == null) throw UpdateException(UpdateException.Kind.HASH_MISSING)
        dir.mkdirs()
        clean()
        val part = File(dir, "update.apk.part")
        val target = File(dir, "update.apk")
        val client = if (viaGithub) TixHttpClient.createGithub(githubUserAgent) else TixHttpClient.create()
        var done = false
        try {
            val consume: suspend (HttpResponse) -> String = { response ->
                if (response.status.value !in 200..299) {
                    throw UpdateException(UpdateException.Kind.HTTP, "HTTP ${response.status.value}")
                }
                val limit = ApkUpdate.downloadLimit(announcedSizeBytes)
                val total = response.contentLength() ?: announcedSizeBytes
                if (total > limit) throw UpdateException(UpdateException.Kind.TOO_LARGE)
                val channel = response.bodyAsChannel()
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(64 * 1024)
                var read = 0L
                part.outputStream().use { out ->
                    while (true) {
                        coroutineContext.ensureActive()
                        val n = channel.readAvailable(buffer, 0, buffer.size)
                        if (n < 0) break
                        if (n == 0) continue
                        read += n
                        if (read > limit) throw UpdateException(UpdateException.Kind.TOO_LARGE)
                        try {
                            out.write(buffer, 0, n)
                        } catch (e: IOException) {
                            throw UpdateException(UpdateException.Kind.STORAGE, e.message, e)
                        }
                        digest.update(buffer, 0, n)
                        onProgress(read, total)
                    }
                }
                digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            }
            // The whole download may take minutes; the socket timeout (no data for 30 s) still applies.
            val hex = if (viaGithub) {
                client.githubGet(url, longRunning = true, block = consume)
            } else {
                client.prepareGet(url) { timeout { requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS } }.execute { consume(it) }
            }
            if (!ApkUpdate.sha256Matches(expectedSha256, hex)) throw UpdateException(UpdateException.Kind.HASH_MISMATCH)
            if (!part.renameTo(target)) throw UpdateException(UpdateException.Kind.STORAGE, "rename failed")
            done = true
            return target
        } catch (e: UpdateException) {
            throw e
        } catch (e: ServerUrlRefusedException) {
            throw UpdateException(UpdateException.Kind.URL_REFUSED, e.message, e)
        } catch (e: GithubUrlRefusedException) {
            throw UpdateException(UpdateException.Kind.URL_REFUSED, e.message, e)
        } catch (e: IOException) {
            throw UpdateException(UpdateException.Kind.NETWORK, e.message, e)
        } finally {
            client.close()
            if (!done) clean()
        }
    }
}
