package org.tix.checkin.update

import android.content.Context
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.contentLength
import io.ktor.utils.io.readAvailable
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import org.tix.checkin.core.GithubRateLimit
import org.tix.checkin.core.GithubReleases
import org.tix.checkin.core.GithubUpdateCandidate
import org.tix.checkin.core.Sha256Sums
import org.tix.checkin.core.UpdateChannel
import org.tix.checkin.core.UpdateSchedule
import org.tix.checkin.core.contract.AppLatest
import org.tix.checkin.net.TixHttpClient

class GithubUpdateException(val kind: Kind, val retryAtMillis: Long = 0, cause: Throwable? = null) : Exception(kind.name, cause) {
    enum class Kind { RATE_LIMITED, NETWORK, HTTP, BAD_RESPONSE, REPOSITORY_INVALID, URL_REFUSED, CHECKSUM_MISSING }
}

/**
 * Finds the newest installable release of a GitHub repository (docs/SCANNER.md "App updates").
 *
 * Requests are kept far below the unauthenticated limit of 60 per hour: the release list is cached for an hour
 * (automatic checks), refreshed with `If-None-Match` (a 304 is free), and after a 403/429 nothing is sent until
 * the reset time. The device token is never sent: the client has no credentials.
 */
class GithubUpdateChecker(
    context: Context,
    private val userAgent: String,
    private val installedVersionCode: Int,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val prefs = context.getSharedPreferences("tix_github_updates", Context.MODE_PRIVATE)
    private val cacheDir = context.cacheDir

    /** One cache file per repository: a file can never be read for another repository than it was fetched for. */
    private fun cacheFile(repository: String): File {
        val hash = MessageDigest.getInstance("SHA-256").digest(repository.toByteArray()).take(8).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return File(cacheDir, "github-releases-$hash.json")
    }

    /** Reads at most [limit] bytes of the body; a larger one is a bad response (never buffered whole). */
    private suspend fun HttpResponse.readBounded(limit: Int): ByteArray {
        if ((contentLength() ?: 0) > limit) throw GithubUpdateException(GithubUpdateException.Kind.BAD_RESPONSE)
        val channel = bodyAsChannel()
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val n = channel.readAvailable(buffer, 0, buffer.size)
            if (n < 0) break
            if (n == 0) continue
            if (out.size() + n > limit) throw GithubUpdateException(GithubUpdateException.Kind.BAD_RESPONSE)
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    /** Result of the last network or cache lookup was at this time (background cadence). */
    private fun lastBackgroundCheck() = prefs.getLong(KEY_LAST_BACKGROUND, 0)

    /**
     * The newer release on [channel] as an [AppLatest] (with SHA-256 from `SHA256SUMS.txt`), or null when the
     * installed version is current / no suitable release exists. [force] asks GitHub again (conditional request)
     * even when the cached list is younger than an hour.
     */
    suspend fun check(repository: String, channel: UpdateChannel, force: Boolean): AppLatest? {
        val releases = releases(repository, force)
        val candidate = GithubReleases.select(releases, channel, repository) ?: return null
        if (candidate.version.versionCode <= installedVersionCode) return null
        return toLatest(candidate)
    }

    /** At most every six hours: refreshes the cached list so the settings screen opens with a current answer. */
    suspend fun backgroundCheck(repository: String, channel: UpdateChannel) {
        // Random 0-30 min added per attempt so devices behind one venue address do not ask GitHub at the same moment.
        if (!UpdateSchedule.backgroundDue(now(), lastBackgroundCheck() + prefs.getLong(KEY_JITTER, 0))) return
        prefs.edit().putLong(KEY_LAST_BACKGROUND, now()).putLong(KEY_JITTER, kotlin.random.Random.nextLong(0, 30 * 60_000L)).apply()
        try {
            check(repository, channel, force = false)
        } catch (_: Exception) {
            // Best effort; the settings screen reports problems when the operator looks.
        }
    }

    private suspend fun toLatest(candidate: GithubUpdateCandidate): AppLatest {
        val sums = fetchText(candidate.sumsUrl)
        val sha = Sha256Sums.find(sums, candidate.apkName) ?: throw GithubUpdateException(GithubUpdateException.Kind.CHECKSUM_MISSING)
        return AppLatest(
            versionName = candidate.version.name,
            versionCode = candidate.version.versionCode,
            sha256 = sha,
            sizeBytes = candidate.apkSize,
            notes = candidate.notes?.take(2_000),
            downloadUrl = candidate.apkUrl,
            viaGithub = true,
        )
    }

    private suspend fun fetchText(url: String): String {
        val client = TixHttpClient.createGithub(userAgent)
        try {
            return client.githubGet(url) { r ->
                if (r.status.value != 200) throw GithubUpdateException(GithubUpdateException.Kind.HTTP)
                r.readBounded(MAX_SUMS_BYTES.toInt()).toString(Charsets.UTF_8)
            }
        } catch (e: GithubUpdateException) {
            throw e
        } catch (e: GithubUrlRefusedException) {
            throw GithubUpdateException(GithubUpdateException.Kind.URL_REFUSED, cause = e)
        } catch (e: IOException) {
            throw GithubUpdateException(GithubUpdateException.Kind.NETWORK, cause = e)
        } finally {
            client.close()
        }
    }

    private fun cached(repository: String): List<org.tix.checkin.core.GithubRelease>? {
        val file = cacheFile(repository)
        if (prefs.getString(KEY_REPO, null) != repository || !file.exists()) return null
        return try {
            GithubReleases.parse(file.readText())
        } catch (_: IOException) {
            null
        }
    }

    private suspend fun releases(repository: String, force: Boolean): List<org.tix.checkin.core.GithubRelease> {
        val url = GithubReleases.releasesUrl(repository) ?: throw GithubUpdateException(GithubUpdateException.Kind.REPOSITORY_INVALID)
        val cache = cached(repository)
        val t = now()
        val blockedUntil = prefs.getLong(KEY_BLOCKED_UNTIL, 0)
        if (t < blockedUntil) return cache ?: throw GithubUpdateException(GithubUpdateException.Kind.RATE_LIMITED, blockedUntil)
        if (cache != null && !force && !UpdateSchedule.cacheExpired(t, prefs.getLong(KEY_FETCHED_AT, 0))) return cache

        val headers = buildMap {
            put("Accept", "application/vnd.github+json")
            put("X-GitHub-Api-Version", "2022-11-28")
            if (cache != null) prefs.getString(KEY_ETAG, null)?.let { put("If-None-Match", it) }
        }
        val client = TixHttpClient.createGithub(userAgent)
        try {
            return client.githubGet(url, headers) { r ->
                val status = r.status.value
                when {
                    status == 304 && cache != null -> {
                        prefs.edit().putLong(KEY_FETCHED_AT, now()).apply()
                        cache
                    }
                    status == 200 -> {
                        val body = r.readBounded(MAX_RELEASES_BYTES).toString(Charsets.UTF_8)
                        val parsed = GithubReleases.parse(body) ?: throw GithubUpdateException(GithubUpdateException.Kind.BAD_RESPONSE)
                        writeCache(repository, body)
                        prefs.edit()
                            .putString(KEY_REPO, repository).putString(KEY_ETAG, r.headers["ETag"])
                            .putLong(KEY_FETCHED_AT, now()).remove(KEY_BLOCKED_UNTIL).apply()
                        parsed
                    }
                    else -> {
                        val until = GithubRateLimit.blockedUntil(
                            status, r.headers["X-RateLimit-Remaining"], r.headers["X-RateLimit-Reset"], r.headers["Retry-After"], now(),
                        )
                        if (until != null) {
                            prefs.edit().putLong(KEY_BLOCKED_UNTIL, until).apply()
                            cache ?: throw GithubUpdateException(GithubUpdateException.Kind.RATE_LIMITED, until)
                        } else {
                            throw GithubUpdateException(GithubUpdateException.Kind.HTTP)
                        }
                    }
                }
            }
        } catch (e: GithubUpdateException) {
            throw e
        } catch (e: GithubUrlRefusedException) {
            throw GithubUpdateException(GithubUpdateException.Kind.URL_REFUSED, cause = e)
        } catch (e: IOException) {
            throw GithubUpdateException(GithubUpdateException.Kind.NETWORK, cause = e)
        } finally {
            client.close()
        }
    }

    /** Temp file + rename; caches of other repositories (and the old unkeyed file name) are removed. */
    private fun writeCache(repository: String, body: String) {
        val target = cacheFile(repository)
        val tmp = File(cacheDir, "github-releases.tmp")
        tmp.writeText(body)
        if (!tmp.renameTo(target)) {
            target.delete()
            if (!tmp.renameTo(target)) throw IOException("cache rename failed")
        }
        cacheDir.listFiles()?.filter { it.name.startsWith("github-releases") && it != target }?.forEach { it.delete() }
    }

    private companion object {
        const val MAX_RELEASES_BYTES = 2 * 1024 * 1024
        const val KEY_REPO = "repo"
        const val KEY_ETAG = "etag"
        const val KEY_FETCHED_AT = "fetched_at"
        const val KEY_BLOCKED_UNTIL = "blocked_until"
        const val KEY_LAST_BACKGROUND = "last_background"
        const val KEY_JITTER = "background_jitter"
        const val MAX_SUMS_BYTES = 64L * 1024
    }
}
