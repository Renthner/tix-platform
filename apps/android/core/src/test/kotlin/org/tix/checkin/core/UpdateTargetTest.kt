package org.tix.checkin.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UpdateTargetTest {
    private fun v(s: String) = AppVersion.parse(s)!!

    @Test
    fun `equal versions are up to date`() {
        assertEquals(UpdateTarget.UpToDate, UpdateTarget.decide(v("1.0.0-alpha.4"), "1.0.0-alpha.4"))
    }

    @Test
    fun `newer server offers exactly the server version`() {
        assertEquals(UpdateTarget.UpdateAvailable(v("1.0.0-alpha.5")), UpdateTarget.decide(v("1.0.0-alpha.4"), "1.0.0-alpha.5"))
        assertEquals(UpdateTarget.UpdateAvailable(v("1.0.0")), UpdateTarget.decide(v("1.0.0-rc.1"), "1.0.0"))
    }

    @Test
    fun `newer app is never downgraded`() {
        assertEquals(UpdateTarget.AppNewerThanServer(v("1.0.0-alpha.3")), UpdateTarget.decide(v("1.0.0-alpha.4"), "1.0.0-alpha.3"))
        assertTrue(UpdateTarget.decide(v("1.0.0"), "1.0.0-rc.2") is UpdateTarget.AppNewerThanServer)
    }

    @Test
    fun `missing or unparsable server version falls back to the channel logic`() {
        assertEquals(UpdateTarget.UnknownServerVersion, UpdateTarget.decide(v("1.0.0"), null))
        assertEquals(UpdateTarget.UnknownServerVersion, UpdateTarget.decide(v("1.0.0"), ""))
        assertEquals(UpdateTarget.UnknownServerVersion, UpdateTarget.decide(v("1.0.0"), "dev"))
        assertEquals(UpdateTarget.UnknownServerVersion, UpdateTarget.decide(v("1.0.0"), "v1.0.0"))
    }
}

class GithubSelectVersionTest {
    private val repo = "example-org/tix-platform"

    private fun asset(name: String, tag: String) = GithubAsset(name, 1000, "https://github.com/$repo/releases/download/$tag/$name")

    private fun release(tag: String, draft: Boolean = false, prerelease: Boolean = false, assets: List<GithubAsset>? = null): GithubRelease {
        val v = tag.removePrefix("v")
        return GithubRelease(tag, draft, prerelease, "n", assets ?: listOf(asset("tix-checkin-$v.apk", tag), asset("SHA256SUMS.txt", tag)))
    }

    private fun v(s: String) = AppVersion.parse(s)!!

    @Test
    fun `finds exactly the tag, pre-releases allowed, newer releases ignored`() {
        val list = listOf(release("v1.1.0"), release("v1.0.0-alpha.5", prerelease = true), release("v1.0.0-alpha.4", prerelease = true))
        assertEquals("1.0.0-alpha.5", GithubReleases.selectVersion(list, v("1.0.0-alpha.5"), repo)!!.version.name)
    }

    @Test
    fun `missing tag gives null`() {
        assertNull(GithubReleases.selectVersion(listOf(release("v1.1.0")), v("1.0.0"), repo))
    }

    @Test
    fun `draft is skipped`() {
        assertNull(GithubReleases.selectVersion(listOf(release("v1.0.0", draft = true)), v("1.0.0"), repo))
    }

    @Test
    fun `release without apk or checksum is skipped`() {
        val noApk = release("v1.0.0", assets = listOf(asset("SHA256SUMS.txt", "v1.0.0")))
        val noSums = release("v1.0.0", assets = listOf(asset("tix-checkin-1.0.0.apk", "v1.0.0")))
        assertNull(GithubReleases.selectVersion(listOf(noApk, noSums), v("1.0.0"), repo))
    }

    @Test
    fun `assets pointing to another repository or another tag are skipped`() {
        val otherRepo = release(
            "v1.0.0",
            assets = listOf(
                GithubAsset("tix-checkin-1.0.0.apk", 1000, "https://github.com/someone-else/tix-platform/releases/download/v1.0.0/tix-checkin-1.0.0.apk"),
                asset("SHA256SUMS.txt", "v1.0.0"),
            ),
        )
        val otherTag = release("v1.0.0", assets = listOf(asset("tix-checkin-1.0.0.apk", "v0.9.0"), asset("SHA256SUMS.txt", "v1.0.0")))
        val otherTagSums = release("v1.0.0", assets = listOf(asset("tix-checkin-1.0.0.apk", "v1.0.0"), asset("SHA256SUMS.txt", "v0.9.0")))
        assertNull(GithubReleases.selectVersion(listOf(otherRepo), v("1.0.0"), repo))
        assertNull(GithubReleases.selectVersion(listOf(otherTag), v("1.0.0"), repo))
        assertNull(GithubReleases.selectVersion(listOf(otherTagSums), v("1.0.0"), repo))
    }

    @Test
    fun `parseOne decodes a single release object and refuses anything else`() {
        val json = """{"tag_name":"v1.0.0","draft":false,"prerelease":false,"body":"n","assets":[{"name":"a","size":1,"browser_download_url":"https://github.com/x/y/releases/download/v1.0.0/a"}]}"""
        val one = GithubReleases.parseOne(json)!!
        assertEquals("v1.0.0", one.tagName)
        assertEquals(1, one.assets.size)
        assertNull(GithubReleases.parseOne("[]"))
        assertNull(GithubReleases.parseOne("not json"))
        assertNull(GithubReleases.parseOne("""{"message":"Not Found"}""")?.takeIf { it.tagName.isNotEmpty() })
    }

    @Test
    fun `tagUrl is built for valid repositories only`() {
        assertEquals("https://api.github.com/repos/$repo/releases/tags/v1.0.0-alpha.5", GithubReleases.tagUrl(repo, v("1.0.0-alpha.5")))
        assertNull(GithubReleases.tagUrl("../x", v("1.0.0")))
    }
}
