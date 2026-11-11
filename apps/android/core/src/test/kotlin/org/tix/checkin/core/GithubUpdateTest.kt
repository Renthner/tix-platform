package org.tix.checkin.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AppVersionTest {
    @Test
    fun `SemVer precedence incl pre-release ordering (mirrors scripts release tests)`() {
        val order = listOf(
            "1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-beta.1", "1.0.0-rc.1", "1.0.0-rc.2",
            "1.0.0", "1.0.1", "1.1.0-alpha.1", "1.1.0", "2.0.0-alpha.1",
        ).map { assertNotNull(AppVersion.parse(it), it) }
        for (i in 0 until order.size - 1) {
            assertTrue(order[i] < order[i + 1], "${order[i].name} < ${order[i + 1].name}")
            assertTrue(order[i + 1] > order[i])
        }
        assertEquals(0, AppVersion.parse("1.2.3")!!.compareTo(AppVersion.parse("1.2.3")!!))
    }

    @Test
    fun `versionCode derivation`() {
        assertEquals(1_000_001, AppVersion.parse("1.0.0-alpha.1")!!.versionCode)
        assertEquals(1_000_002, AppVersion.parse("1.0.0-alpha.2")!!.versionCode)
        assertEquals(1_000_031, AppVersion.parse("1.0.0-beta.1")!!.versionCode)
        assertEquals(1_000_061, AppVersion.parse("1.0.0-rc.1")!!.versionCode)
        assertEquals(1_000_099, AppVersion.parse("1.0.0")!!.versionCode)
        assertEquals(1_020_399, AppVersion.parse("1.2.3")!!.versionCode)
        assertEquals(2_000_000_000 + 99 * 10_000 + 99 * 100 + 99, AppVersion.parse("2000.99.99")!!.versionCode)
    }

    @Test
    fun `versionCode order equals version order`() {
        val versions = listOf("1.0.0-alpha.2", "1.0.0-beta.1", "1.0.0-rc.29", "1.0.0", "1.0.1-alpha.1", "1.1.0")
            .map { AppVersion.parse(it)!! }
        assertEquals(versions.sorted(), versions)
        assertEquals(versions.map { it.versionCode }.sorted(), versions.map { it.versionCode })
    }

    @Test
    fun `invalid versions are rejected`() {
        for (bad in listOf("", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-alpha", "1.2.3-alpha.0", "1.2.3-alpha.30", "1.2.3-dev.1",
            "1.2.3-ALPHA.1", "1.100.0", "1.0.100", "2001.0.0", "01.2.3x", "1.2.3+build", "1.2.3-rc.1-x", " 1.2.3")) {
            assertNull(AppVersion.parse(bad), "should be rejected: '$bad'")
        }
    }

    @Test
    fun `tags need the v prefix`() {
        assertEquals("1.0.0-alpha.2", AppVersion.parseTag("v1.0.0-alpha.2")!!.name)
        assertNull(AppVersion.parseTag("1.0.0"))
        assertNull(AppVersion.parseTag("release-1.0.0"))
        assertNull(AppVersion.parseTag("v"))
    }
}

class GithubReleasesTest {
    private val repo = "example-org/tix-platform"

    private fun asset(name: String, tag: String, host: String = "github.com", path: String = repo) =
        GithubAsset(name, 1000, "https://$host/$path/releases/download/$tag/$name")

    private fun release(
        tag: String,
        draft: Boolean = false,
        prerelease: Boolean = false,
        assets: List<GithubAsset>? = null,
    ): GithubRelease {
        val v = tag.removePrefix("v")
        return GithubRelease(
            tag, draft, prerelease, "notes $tag",
            assets ?: listOf(asset("tix-checkin-$v.apk", tag), asset("SHA256SUMS.txt", tag)),
        )
    }

    @Test
    fun `stable skips drafts and pre-releases and picks the newest by semver`() {
        val list = listOf(
            release("v1.1.0-rc.1", prerelease = true),
            release("v1.0.0"),
            release("v1.2.0", draft = true),
            release("v0.9.0"),
        )
        assertEquals("1.0.0", GithubReleases.select(list, UpdateChannel.STABLE, repo)!!.version.name)
    }

    @Test
    fun `a pre-release version is skipped on stable even when GitHub does not flag it`() {
        val list = listOf(release("v1.1.0-beta.1", prerelease = false), release("v1.0.0"))
        assertEquals("1.0.0", GithubReleases.select(list, UpdateChannel.STABLE, repo)!!.version.name)
    }

    @Test
    fun `next includes pre-releases but still skips drafts`() {
        val list = listOf(release("v1.0.0"), release("v1.1.0-alpha.2", prerelease = true), release("v2.0.0-alpha.1", draft = true, prerelease = true))
        assertEquals("1.1.0-alpha.2", GithubReleases.select(list, UpdateChannel.NEXT, repo)!!.version.name)
    }

    @Test
    fun `final release beats its own pre-release on next`() {
        val list = listOf(release("v1.0.0-rc.1", prerelease = true), release("v1.0.0"))
        assertEquals("1.0.0", GithubReleases.select(list, UpdateChannel.NEXT, repo)!!.version.name)
    }

    @Test
    fun `sorted by semver not by list order or date`() {
        val newestFirstButOlderVersion = listOf(release("v1.0.3"), release("v1.0.10"), release("v1.0.9"))
        assertEquals("1.0.10", GithubReleases.select(newestFirstButOlderVersion, UpdateChannel.STABLE, repo)!!.version.name)
    }

    @Test
    fun `releases without the apk or the checksum file are skipped`() {
        val noApk = release("v1.2.0", assets = listOf(asset("SHA256SUMS.txt", "v1.2.0")))
        val noSums = release("v1.1.0", assets = listOf(asset("tix-checkin-1.1.0.apk", "v1.1.0")))
        val wrongName = release("v1.3.0", assets = listOf(asset("tix-checkin-1.2.9.apk", "v1.3.0"), asset("SHA256SUMS.txt", "v1.3.0")))
        val ok = release("v1.0.0")
        assertEquals("1.0.0", GithubReleases.select(listOf(noApk, noSums, wrongName, ok), UpdateChannel.STABLE, repo)!!.version.name)
        assertNull(GithubReleases.select(listOf(noApk, noSums, wrongName), UpdateChannel.STABLE, repo))
    }

    @Test
    fun `malformed tags are skipped`() {
        val list = listOf(release("1.5.0", assets = null), release("nightly"), release("v1.4"), release("v1.0.0"))
        assertEquals("1.0.0", GithubReleases.select(list, UpdateChannel.NEXT, repo)!!.version.name)
    }

    @Test
    fun `assets on foreign hosts are refused`() {
        val evil = release("v2.0.0", assets = listOf(asset("tix-checkin-2.0.0.apk", "v2.0.0", "evil.example"), asset("SHA256SUMS.txt", "v2.0.0")))
        val ok = release("v1.0.0")
        assertEquals("1.0.0", GithubReleases.select(listOf(evil, ok), UpdateChannel.STABLE, repo)!!.version.name)
    }

    @Test
    fun `assets must live under the repository release path of their tag`() {
        val otherRepo = release("v2.0.0", assets = listOf(asset("tix-checkin-2.0.0.apk", "v2.0.0", path = "evil/tix-platform"), asset("SHA256SUMS.txt", "v2.0.0", path = "evil/tix-platform")))
        val otherTag = release("v1.5.0", assets = listOf(asset("tix-checkin-1.5.0.apk", "v1.4.0"), asset("SHA256SUMS.txt", "v1.5.0")))
        val ok = release("v1.0.0")
        assertEquals("1.0.0", GithubReleases.select(listOf(otherRepo, otherTag, ok), UpdateChannel.STABLE, repo)!!.version.name)
        assertNull(GithubReleases.select(listOf(otherRepo, otherTag), UpdateChannel.STABLE, repo))
        assertEquals("1.0.0", GithubReleases.select(listOf(ok), UpdateChannel.STABLE, "Example-Org/Tix-Platform")!!.version.name, "case-insensitive")
    }

    @Test
    fun `effective repository prefers the server value over the built-in one`() {
        assertEquals("a/b", GithubReleases.effectiveRepository(" a/b ", "c/d"))
        assertEquals("c/d", GithubReleases.effectiveRepository("", "c/d"))
        assertEquals("", GithubReleases.effectiveRepository("", ""))
    }

    @Test
    fun `candidate carries the links and notes`() {
        val c = GithubReleases.select(listOf(release("v1.0.0")), UpdateChannel.STABLE, repo)!!
        assertEquals("tix-checkin-1.0.0.apk", c.apkName)
        assertTrue(c.apkUrl.endsWith("/tix-checkin-1.0.0.apk"))
        assertTrue(c.sumsUrl.endsWith("/SHA256SUMS.txt"))
        assertEquals("notes v1.0.0", c.notes)
        assertEquals(1_000_099, c.version.versionCode)
    }

    @Test
    fun `parses the GitHub releases json and ignores unknown or broken entries`() {
        val json = """
            [
              {"url":"x","tag_name":"v1.0.0-alpha.2","draft":false,"prerelease":true,"body":"b","author":{"login":"x"},
               "assets":[{"name":"tix-checkin-1.0.0-alpha.2.apk","size":5,"browser_download_url":"https://github.com/example-org/tix-platform/releases/download/v1.0.0-alpha.2/tix-checkin-1.0.0-alpha.2.apk","id":1},
                         {"name":"SHA256SUMS.txt","size":1,"browser_download_url":"https://github.com/example-org/tix-platform/releases/download/v1.0.0-alpha.2/SHA256SUMS.txt"}]},
              {"tag_name":123},
              "garbage"
            ]
        """.trimIndent()
        val list = assertNotNull(GithubReleases.parse(json))
        assertEquals(1, list.size)
        assertEquals("1.0.0-alpha.2", GithubReleases.select(list, UpdateChannel.NEXT, repo)!!.version.name)
        assertNull(GithubReleases.select(list, UpdateChannel.STABLE, repo))
        assertNull(GithubReleases.parse("""{"message":"Not Found"}"""))
        assertNull(GithubReleases.parse("not json"))
    }

    @Test
    fun `repository validation and url`() {
        assertEquals("https://api.github.com/repos/some-org/tix.platform_2/releases?per_page=30", GithubReleases.releasesUrl("some-org/tix.platform_2"))
        for (bad in listOf("", "owner", "a/b/c", "../x", "a b/c", "a/b?x=1", "a@evil.com/x", "/repo", "./x", "x/..", "../..", "x/.")) assertNull(GithubReleases.releasesUrl(bad), bad)
    }

    @Test
    fun `effective channel honours the override only when the server allows it`() {
        assertEquals(UpdateChannel.NEXT, UpdateChannel.effective(UpdateChannel.STABLE, true, UpdateChannel.NEXT))
        assertEquals(UpdateChannel.STABLE, UpdateChannel.effective(UpdateChannel.STABLE, false, UpdateChannel.NEXT))
        assertEquals(UpdateChannel.STABLE, UpdateChannel.effective(UpdateChannel.STABLE, true, null))
    }

    @Test
    fun `channel and source wire values`() {
        assertEquals(UpdateChannel.NEXT, UpdateChannel.fromWire("next"))
        assertNull(UpdateChannel.fromWire("beta"))
        assertEquals(UpdateSource.GITHUB, UpdateSource.fromWire("GITHUB"))
        assertNull(UpdateSource.fromWire("github"))
    }
}

class Sha256SumsTest {
    private val a = "a".repeat(64)
    private val b = "B".repeat(64)

    @Test
    fun `finds the line of the apk`() {
        val text = "$a  tix-checkin-1.0.0.apk\n$b *other.bin\n"
        assertEquals(a, Sha256Sums.find(text, "tix-checkin-1.0.0.apk"))
        assertEquals("b".repeat(64), Sha256Sums.find(text, "other.bin"))
        assertNull(Sha256Sums.find(text, "tix-checkin-2.0.0.apk"))
    }

    @Test
    fun `tolerates CRLF, blank and malformed lines and requires an exact file name`() {
        val text = "\r\n# comment\r\nzz  x.apk\r\n$a  tix-checkin-1.0.0.apk\r\n${"c".repeat(63)}  short.apk\r\n"
        assertEquals(a, Sha256Sums.find(text, "tix-checkin-1.0.0.apk"))
        assertNull(Sha256Sums.find(text, "short.apk"))
        assertNull(Sha256Sums.find(text, "1.0.0.apk"), "no suffix matching")
        assertNull(Sha256Sums.find("", "x"))
    }

    @Test
    fun `first entry wins on duplicates`() {
        val text = "$a  f.apk\n${"d".repeat(64)}  f.apk\n"
        assertEquals(a, Sha256Sums.find(text, "f.apk"))
    }
}

class GithubHostsTest {
    @Test
    fun `allow list`() {
        for (ok in listOf(
            "https://github.com/o/r/releases/download/v1/x.apk",
            "https://api.github.com/repos/o/r/releases",
            "https://objects.githubusercontent.com/github-production-release-asset/1",
            "https://release-assets.githubusercontent.com/x?y=1",
            "https://anything.githubusercontent.com/x",
            "https://github.com:443/x",
        )) assertTrue(GithubHosts.isAllowedUrl(ok), ok)
        for (bad in listOf(
            "http://github.com/x",
            "https://evil.example/x",
            "https://github.com.evil.example/x",
            "https://evilgithub.com/x",
            "https://githubusercontent.com/x",
            "https://notgithubusercontent.com/x",
            "https://user@github.com/x",
            "https://github.com:8443/x",
            "https://127.0.0.1/x",
            "file:///sdcard/x.apk",
            "intent://x",
            "",
            "github.com/x",
        )) assertFalse(GithubHosts.isAllowedUrl(bad), bad)
    }

    @Test
    fun `redirects follow the allow list, https only, at most five hops`() {
        val from = "https://github.com/o/r/releases/download/v1/x.apk"
        assertEquals("https://objects.githubusercontent.com/a?b=1", GithubHosts.redirectTarget(from, "https://objects.githubusercontent.com/a?b=1", 0))
        assertEquals("https://github.com/other", GithubHosts.redirectTarget(from, "/other", 0))
        assertNull(GithubHosts.redirectTarget(from, "http://objects.githubusercontent.com/a", 0), "downgrade to http")
        assertNull(GithubHosts.redirectTarget(from, "https://evil.example/a", 0))
        assertNull(GithubHosts.redirectTarget(from, "", 0))
        assertNotNull(GithubHosts.redirectTarget(from, "/a", 4))
        assertNull(GithubHosts.redirectTarget(from, "/a", GithubHosts.MAX_REDIRECTS))
    }
}

class GithubRateLimitTest {
    private val now = 1_800_000_000_000L

    @Test
    fun `403 with no remaining requests waits for the reset time`() {
        val reset = (now / 1000) + 1800
        assertEquals(reset * 1000, GithubRateLimit.blockedUntil(403, "0", reset.toString(), null, now))
    }

    @Test
    fun `429 and retry-after`() {
        assertEquals(now + 120_000, GithubRateLimit.blockedUntil(429, null, null, "120", now))
        assertEquals(now + GithubRateLimitDefaults.HOUR, GithubRateLimit.blockedUntil(429, null, null, null, now))
        assertEquals(now + 90_000, GithubRateLimit.blockedUntil(403, "5", null, "90", now), "secondary limit")
    }

    @Test
    fun `an ordinary 403 or other status is not a rate limit`() {
        assertNull(GithubRateLimit.blockedUntil(403, "42", "1", null, now))
        assertNull(GithubRateLimit.blockedUntil(404, "0", "1", null, now))
        assertNull(GithubRateLimit.blockedUntil(200, "0", "1", null, now))
    }

    @Test
    fun `wait is clamped`() {
        assertEquals(now + 60_000, GithubRateLimit.blockedUntil(403, "0", ((now / 1000) - 500).toString(), null, now), "reset in the past")
        assertEquals(now + 24 * 3_600_000L, GithubRateLimit.blockedUntil(429, null, null, "999999999", now))
    }
}

private object GithubRateLimitDefaults {
    const val HOUR = 3_600_000L
}

class UpdateScheduleTest {
    @Test
    fun `cache for one hour, background check every six hours`() {
        val now = 10_000_000_000L
        assertFalse(UpdateSchedule.cacheExpired(now, now - 59 * 60_000))
        assertTrue(UpdateSchedule.cacheExpired(now, now - 60 * 60_000))
        assertTrue(UpdateSchedule.cacheExpired(now, 0))
        assertFalse(UpdateSchedule.backgroundDue(now, now - 5 * 3_600_000L))
        assertTrue(UpdateSchedule.backgroundDue(now, now - 6 * 3_600_000L))
        assertTrue(UpdateSchedule.backgroundDue(now, now + 1_000), "clock went backwards: check again")
    }
}

class SignerMatchTest {
    private val a = "a".repeat(64)
    private val b = "b".repeat(64)
    private val c = "c".repeat(64)
    private fun s(vararg current: String, history: Set<String> = emptySet()) = ApkUpdate.Signers(current.toSet(), history)

    @Test
    fun `same certificate matches, another one does not`() {
        assertTrue(ApkUpdate.signersMatch(s(a), s(a)))
        assertFalse(ApkUpdate.signersMatch(s(a), s(b)))
        assertFalse(ApkUpdate.signersMatch(s(a), s()), "unsigned")
        assertFalse(ApkUpdate.signersMatch(s(), s(a)))
    }

    @Test
    fun `forward rotation A to B is accepted, backwards is not`() {
        // The new APK (B) carries the lineage A -> B; the installed app still has A.
        assertTrue(ApkUpdate.signersMatch(s(a), s(b, history = setOf(a, b))))
        // The installed app already moved to B; an old APK signed with A must not replace it.
        assertFalse(ApkUpdate.signersMatch(s(b, history = setOf(a, b)), s(a)))
        assertFalse(ApkUpdate.signersMatch(s(a), s(b, history = setOf(b))), "installed signer not in the lineage")
        assertFalse(ApkUpdate.signersMatch(s(a), s(b, c, history = setOf(a, b, c))), "several signers: exact match only")
    }

    @Test
    fun `several signers need exact set equality`() {
        assertTrue(ApkUpdate.signersMatch(s(a, b), s(b, a)))
        assertFalse(ApkUpdate.signersMatch(s(a, b), s(a)))
        assertFalse(ApkUpdate.signersMatch(s(a), s(a, b)))
        assertFalse(ApkUpdate.signersMatch(s(a, b), s(c, history = setOf(a, c))))
    }

    @Test
    fun `signer selection falls back to legacy signatures when signingInfo is empty`() {
        assertEquals(s(a, history = setOf(a, b)), ApkUpdate.chooseSigners(listOf(a), listOf(a, b), listOf(c)))
        assertEquals(s(c), ApkUpdate.chooseSigners(null, null, listOf(c)), "API 28/29 archive: signingInfo null")
        assertEquals(s(c), ApkUpdate.chooseSigners(emptyList(), emptyList(), listOf(c)))
        assertEquals(s(), ApkUpdate.chooseSigners(null, null, null))
    }
}
