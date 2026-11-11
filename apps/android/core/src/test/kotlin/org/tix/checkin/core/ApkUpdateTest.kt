package org.tix.checkin.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ApkUpdateTest {
    private val hash = "ab".repeat(32)

    @Test
    fun `version comparison`() {
        assertTrue(ApkUpdate.isNewer(3, 4))
        assertFalse(ApkUpdate.isNewer(4, 4))
        assertFalse(ApkUpdate.isNewer(5, 4))
    }

    @Test
    fun `sha256 normalisation and comparison`() {
        assertEquals(hash, ApkUpdate.normalizeSha256(hash.uppercase()))
        assertEquals(hash, ApkUpdate.normalizeSha256("sha256:$hash"))
        assertEquals(hash, ApkUpdate.normalizeSha256(hash.chunked(2).joinToString(":").uppercase()))
        assertNull(ApkUpdate.normalizeSha256(""))
        assertNull(ApkUpdate.normalizeSha256("abc"))
        assertNull(ApkUpdate.normalizeSha256("zz".repeat(32)))
        assertTrue(ApkUpdate.sha256Matches(hash.uppercase(), hash))
        assertFalse(ApkUpdate.sha256Matches(hash, "cd".repeat(32)))
        assertFalse(ApkUpdate.sha256Matches("", hash), "no checksum from the server: never install")
        assertFalse(ApkUpdate.sha256Matches("garbage", hash))
    }

    @Test
    fun `download limit follows the announced size but never exceeds the cap`() {
        assertEquals(50_000_000L + 64 * 1024, ApkUpdate.downloadLimit(50_000_000))
        assertEquals(ApkUpdate.MAX_APK_BYTES, ApkUpdate.downloadLimit(0))
        assertEquals(ApkUpdate.MAX_APK_BYTES, ApkUpdate.downloadLimit(Long.MAX_VALUE / 2))
    }

    @Test
    fun `unsent scans warn once`() {
        assertEquals(ApkUpdate.Gate.WARN_UNSENT_SCANS, ApkUpdate.gate(3, warnedAlready = false))
        assertEquals(ApkUpdate.Gate.PROCEED, ApkUpdate.gate(3, warnedAlready = true))
        assertEquals(ApkUpdate.Gate.PROCEED, ApkUpdate.gate(0, warnedAlready = false))
    }

    @Test
    fun `installer status mapping`() {
        assertEquals(ApkUpdate.InstallFailure.SIGNATURE, ApkUpdate.installFailure(5))
        assertEquals(ApkUpdate.InstallFailure.SIGNATURE, ApkUpdate.installFailure(7))
        assertEquals(ApkUpdate.InstallFailure.USER_CANCELLED, ApkUpdate.installFailure(3))
        assertEquals(ApkUpdate.InstallFailure.STORAGE, ApkUpdate.installFailure(6))
        assertEquals(ApkUpdate.InstallFailure.BLOCKED, ApkUpdate.installFailure(2))
        assertEquals(ApkUpdate.InstallFailure.INVALID, ApkUpdate.installFailure(4))
        assertEquals(ApkUpdate.InstallFailure.OTHER, ApkUpdate.installFailure(1))
    }
}
