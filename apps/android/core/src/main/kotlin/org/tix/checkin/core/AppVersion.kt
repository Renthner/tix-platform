package org.tix.checkin.core

/**
 * Release version of the app: `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-(alpha|beta|rc).N`.
 *
 * Mirrors `scripts/release/version.mjs` (the same inputs give the same versionCode and ordering):
 * versionCode = MAJOR*1_000_000 + MINOR*10_000 + PATCH*100 + stage with alpha.N -> N, beta.N -> 30+N,
 * rc.N -> 60+N and the final release -> 99.
 */
data class AppVersion(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val stage: Stage?,
    val n: Int?,
) : Comparable<AppVersion> {
    /** Declaration order is the SemVer precedence of pre-release stages. */
    enum class Stage(val wire: String, val base: Int) { ALPHA("alpha", 0), BETA("beta", 30), RC("rc", 60) }

    val prerelease: Boolean get() = stage != null

    val versionCode: Int
        get() = major * 1_000_000 + minor * 10_000 + patch * 100 + (stage?.let { it.base + n!! } ?: 99)

    val name: String
        get() = "$major.$minor.$patch" + (stage?.let { "-${it.wire}.$n" } ?: "")

    /** SemVer precedence: core numbers, then a pre-release is lower than the final release, then alpha < beta < rc, then N. */
    override fun compareTo(other: AppVersion): Int {
        if (major != other.major) return major.compareTo(other.major)
        if (minor != other.minor) return minor.compareTo(other.minor)
        if (patch != other.patch) return patch.compareTo(other.patch)
        if (prerelease != other.prerelease) return if (prerelease) -1 else 1
        if (stage == null) return 0
        if (stage != other.stage) return stage.compareTo(other.stage!!)
        return n!!.compareTo(other.n!!)
    }

    companion object {
        private val SEMVER = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$""")

        /** null for anything that is not a valid release version (same limits as the release script). */
        fun parse(version: String): AppVersion? {
            val m = SEMVER.matchEntire(version) ?: return null
            val major = m.groupValues[1].toIntOrNull() ?: return null
            val minor = m.groupValues[2].toIntOrNull() ?: return null
            val patch = m.groupValues[3].toIntOrNull() ?: return null
            if (major > 2000 || minor > 99 || patch > 99) return null
            val stageWire = m.groups[4]?.value ?: return AppVersion(major, minor, patch, null, null)
            val n = m.groupValues[5].toIntOrNull() ?: return null
            if (n < 1 || n > 29) return null
            val stage = Stage.entries.first { it.wire == stageWire }
            return AppVersion(major, minor, patch, stage, n)
        }

        /** Release tag `v<version>`; null when the `v` prefix is missing or the version is invalid. */
        fun parseTag(tag: String): AppVersion? = if (tag.startsWith("v")) parse(tag.substring(1)) else null
    }
}
