package org.tix.checkin.core

import java.net.URI
import java.net.URISyntaxException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import org.tix.checkin.core.contract.ScannerJson

/** Update channel: `STABLE` = newest final release, `NEXT` = newest release including alpha / beta / rc. */
enum class UpdateChannel(val wire: String) {
    STABLE("stable"), NEXT("next");

    companion object {
        fun fromWire(value: String?): UpdateChannel? = entries.firstOrNull { it.wire == value }

        /** The server default, unless the server allows an override and the operator picked one. */
        fun effective(default: UpdateChannel, allowOverride: Boolean, override: UpdateChannel?): UpdateChannel =
            if (allowOverride && override != null) override else default
    }
}

/** Where the app looks for updates (manifest `settings.appUpdate.source`). */
enum class UpdateSource {
    GITHUB, SERVER;

    companion object {
        fun fromWire(value: String?): UpdateSource? = entries.firstOrNull { it.name == value }
    }
}

@Serializable
data class GithubAsset(
    val name: String = "",
    val size: Long = 0,
    @SerialName("browser_download_url") val browserDownloadUrl: String = "",
)

@Serializable
data class GithubRelease(
    @SerialName("tag_name") val tagName: String = "",
    val draft: Boolean = false,
    val prerelease: Boolean = false,
    val body: String? = null,
    val assets: List<GithubAsset> = emptyList(),
)

/** A release that can be installed: version, APK link and the link of its checksum file. */
data class GithubUpdateCandidate(
    val version: AppVersion,
    val apkName: String,
    val apkUrl: String,
    val apkSize: Long,
    val sumsUrl: String,
    val notes: String?,
)

object GithubReleases {
    const val SUMS_ASSET = "SHA256SUMS.txt"
    private val REPOSITORY = Regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")

    /** `owner/repo`; a `.` or `..` segment is refused (path traversal in the API URL). */
    fun isValidRepository(repository: String): Boolean =
        repository.length <= 140 && REPOSITORY.matches(repository) && repository.split('/').none { it == "." || it == ".." }

    /** The repository the app uses: the server's (admin) setting, else the one built into the app (may be empty). */
    fun effectiveRepository(fromServer: String, builtIn: String): String = fromServer.trim().ifEmpty { builtIn.trim() }

    /** Releases list URL of an `owner/repo`; null when the repository name is not valid. */
    fun releasesUrl(repository: String, perPage: Int = 30): String? =
        if (isValidRepository(repository)) "https://api.github.com/repos/$repository/releases?per_page=$perPage" else null

    fun apkAssetName(version: AppVersion) = "tix-checkin-${version.name}.apk"

    /** Decodes the releases JSON; entries that do not look like a release are dropped. Null when it is not a JSON array. */
    fun parse(json: String, decoder: Json = ScannerJson): List<GithubRelease>? {
        val array = try {
            decoder.parseToJsonElement(json) as? JsonArray
        } catch (_: Exception) {
            null
        } ?: return null
        return array.mapNotNull { element ->
            try {
                decoder.decodeFromJsonElement(GithubRelease.serializer(), element)
            } catch (_: Exception) {
                null
            }
        }
    }

    /**
     * The release to offer on [channel]: drafts are skipped, `stable` also skips pre-releases (by the GitHub flag
     * and by the version), tags must be `v<semver>`, the APK `tix-checkin-<version>.apk` and `SHA256SUMS.txt` must
     * both be attached and live at `https://github.com/<repository>/releases/download/<tag>/`. The newest by
     * SemVer wins, not by date.
     */
    fun select(releases: List<GithubRelease>, channel: UpdateChannel, repository: String): GithubUpdateCandidate? =
        releases.asSequence()
            .filter { !it.draft }
            .mapNotNull { release ->
                val version = AppVersion.parseTag(release.tagName) ?: return@mapNotNull null
                if (channel == UpdateChannel.STABLE && (release.prerelease || version.prerelease)) return@mapNotNull null
                val apkName = apkAssetName(version)
                val apk = release.assets.firstOrNull { it.name == apkName } ?: return@mapNotNull null
                val sums = release.assets.firstOrNull { it.name == SUMS_ASSET } ?: return@mapNotNull null
                val prefix = "https://github.com/$repository/releases/download/${release.tagName}/"
                if (!apk.browserDownloadUrl.startsWith(prefix, ignoreCase = true) ||
                    !sums.browserDownloadUrl.startsWith(prefix, ignoreCase = true) ||
                    !GithubHosts.isAllowedUrl(apk.browserDownloadUrl) || !GithubHosts.isAllowedUrl(sums.browserDownloadUrl)
                ) {
                    return@mapNotNull null
                }
                GithubUpdateCandidate(version, apkName, apk.browserDownloadUrl, apk.size, sums.browserDownloadUrl, release.body)
            }
            .maxByOrNull { it.version }
}

/** `SHA256SUMS.txt` as written by `sha256sum`: `<64 hex>  <file name>` (a `*` before the name marks binary mode). */
object Sha256Sums {
    private val LINE = Regex("^([0-9a-fA-F]{64}) [ *](.+)$")

    fun parse(text: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (raw in text.lineSequence()) {
            val m = LINE.matchEntire(raw.trimEnd('\r', '\n')) ?: continue
            out.putIfAbsent(m.groupValues[2], m.groupValues[1].lowercase())
        }
        return out
    }

    /** The checksum of exactly [fileName]; null when it is not listed. */
    fun find(text: String, fileName: String): String? = parse(text)[fileName]
}

/** Hosts a GitHub download may touch. Everything is https only. */
object GithubHosts {
    const val MAX_REDIRECTS = 5

    fun isAllowedHost(host: String): Boolean {
        val h = host.lowercase().trimEnd('.')
        return h == "github.com" || h == "api.github.com" ||
            (h.endsWith(".githubusercontent.com") && h.length > ".githubusercontent.com".length)
    }

    /** https, no user info, default port, allow-listed host. */
    fun isAllowedUrl(url: String): Boolean {
        val uri = try {
            URI(url.trim())
        } catch (_: URISyntaxException) {
            return false
        }
        if (uri.scheme?.lowercase() != "https" || uri.rawUserInfo != null) return false
        if (uri.port != -1 && uri.port != 443) return false
        val host = uri.host ?: return false
        return isAllowedHost(host)
    }

    /**
     * Target of a redirect from [current] to [location] (may be relative); null = refuse. [hop] is the number of
     * redirects followed so far, at most [MAX_REDIRECTS] are accepted.
     */
    fun redirectTarget(current: String, location: String, hop: Int): String? {
        if (hop >= MAX_REDIRECTS || location.isBlank()) return null
        val target = try {
            URI(current).resolve(location.trim()).toString()
        } catch (_: Exception) {
            return null
        }
        return target.takeIf { isAllowedUrl(it) }
    }
}

/** GitHub allows 60 unauthenticated API requests per hour and address; 403/429 carry the reset time. */
object GithubRateLimit {
    private const val MIN_WAIT = 60_000L
    private const val MAX_WAIT = 24 * 3_600_000L
    private const val DEFAULT_WAIT = 3_600_000L

    /**
     * Epoch millis until which no request should be sent, or null when the response is not a rate-limit answer.
     * [remaining] / [resetEpochSeconds] / [retryAfterSeconds] are the raw header values.
     */
    fun blockedUntil(status: Int, remaining: String?, resetEpochSeconds: String?, retryAfterSeconds: String?, nowMillis: Long): Long? {
        val limited = status == 429 || (status == 403 && (remaining?.trim() == "0" || retryAfterSeconds != null))
        if (!limited) return null
        val retry = retryAfterSeconds?.trim()?.toLongOrNull()?.let { nowMillis + it * 1000 }
        val reset = resetEpochSeconds?.trim()?.toLongOrNull()?.let { it * 1000 }
        val until = retry ?: reset ?: (nowMillis + DEFAULT_WAIT)
        return until.coerceIn(nowMillis + MIN_WAIT, nowMillis + MAX_WAIT)
    }
}

/** How often GitHub is asked. */
object UpdateSchedule {
    /** A fetched release list is reused without any request for this long (automatic checks). */
    const val CACHE_MILLIS = 3_600_000L

    /** The background check runs at most this often. */
    const val BACKGROUND_MILLIS = 6 * 3_600_000L

    private fun elapsed(nowMillis: Long, lastMillis: Long, interval: Long) =
        lastMillis <= 0 || nowMillis < lastMillis || nowMillis - lastMillis >= interval

    fun cacheExpired(nowMillis: Long, lastFetchMillis: Long) = elapsed(nowMillis, lastFetchMillis, CACHE_MILLIS)
    fun backgroundDue(nowMillis: Long, lastCheckMillis: Long) = elapsed(nowMillis, lastCheckMillis, BACKGROUND_MILLIS)
}
