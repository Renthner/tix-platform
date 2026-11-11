package org.tix.checkin.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.TokenUnavailableException
import org.tix.checkin.core.scan.DecidedBy
import org.tix.checkin.core.scan.JournalEntry

class UnpairPolicyTest {
    @Test
    fun `only a real revocation unpairs - 401 or 403 with INVALID_TOKEN or DEVICE_REVOKED`() {
        assertTrue(ApiException(401, "INVALID_TOKEN", "x").isUnauthorized)
        assertTrue(ApiException(401, "DEVICE_REVOKED", "x").isUnauthorized)
        assertTrue(ApiException(403, "DEVICE_REVOKED", "x").isUnauthorized)
    }

    @Test
    fun `a captive portal or proxy 401 is treated as an outage`() {
        assertFalse(ApiException(401, null, "HTTP 401").isUnauthorized) // no JSON error code at all
        assertFalse(ApiException(401, "AUTH_REQUIRED", "proxy").isUnauthorized)
        assertFalse(ApiException(403, "EVENT_NOT_ASSIGNED", "x").isUnauthorized)
        assertFalse(ApiException(403, null, "forbidden").isUnauthorized)
        assertFalse(ApiException(500, "DEVICE_REVOKED", "wrong status").isUnauthorized)
    }

    @Test
    fun `an unreadable device key is its own failure, not a server answer`() {
        val e = TokenUnavailableException("keystore", RuntimeException("boom"))
        assertFalse((e as Exception) is ApiException)
        assertEquals("keystore", e.message)
    }
}

class ScanExportTest {
    private fun entry(id: String, error: String? = null) = JournalEntry(
        rowId = 3, clientScanId = id, eventId = "e1", ticketId = "t1", ticketCode = "ABC", payload = org.tix.checkin.core.scan.TestKeys.payload(org.tix.checkin.core.scan.ticketId(1)),
        action = ScanAction.CHECK_IN, source = ScanSource.CAMERA, result = ScanResult.ACCEPTED, warnings = emptyList(),
        warningTexts = emptyMap(), scannedAtMillis = 1_800_000_000_000, entranceId = null, decidedBy = DecidedBy.LOCAL,
        uploaded = false, uploadError = error, attendeeName = "Max Muster", seatLabel = "R B / S 7",
    )

    @Test
    fun `the export lists every unsent scan without names or secrets`() {
        val text = ScanExport.toJson(listOf(entry("a"), entry("b", "refused")), "Door A", 1_800_000_100_000)
        val root = Json.parseToJsonElement(text).jsonObject
        assertEquals(ScanExportFile.FORMAT, root["format"]!!.jsonPrimitive.content)
        assertEquals("Door A", root["deviceName"]!!.jsonPrimitive.content)
        val scans = root["scans"]!!.jsonArray
        assertEquals(2, scans.size)
        val first = scans[0].jsonObject
        assertEquals("a", first["clientScanId"]!!.jsonPrimitive.content)
        // Only the ticket id (parsed from the payload): the signed payload would be a usable ticket.
        assertEquals(org.tix.checkin.core.scan.ticketId(1), first["ticketId"]!!.jsonPrimitive.content)
        assertFalse(first.containsKey("payload"))
        assertFalse(first.containsKey("ticketCode"))
        assertFalse(text.contains("tix://"))
        assertFalse(text.contains("ABC"))
        assertEquals("CHECK_IN", first["action"]!!.jsonPrimitive.content)
        assertEquals("refused", scans[1].jsonObject["uploadError"]!!.jsonPrimitive.content)
        assertFalse(text.contains("Max Muster"))
        assertFalse(text.contains("token", ignoreCase = true))
    }

    @Test
    fun `an empty queue exports an empty list`() {
        val root = Json.parseToJsonElement(ScanExport.toJson(emptyList(), "D", 0)).jsonObject
        assertEquals(0, root["scans"]!!.jsonArray.size)
    }
}

class DownloadUrlTest {
    private val base = "http://192.168.1.20:8080/"

    @Test
    fun `relative links are resolved against the paired server`() {
        assertEquals("http://192.168.1.20:8080/api/app/download?t=1", DownloadUrl.resolve(base, "/api/app/download?t=1"))
        assertEquals("http://192.168.1.20:8080/x", DownloadUrl.resolve(base, "x"))
        assertEquals("https://tix.example/a.apk", DownloadUrl.resolve("https://tix.example", "/a.apk"))
    }

    @Test
    fun `absolute links must pass the server url policy`() {
        assertEquals("https://anything.example/a.apk", DownloadUrl.resolve(base, "https://anything.example/a.apk"))
        assertNull(DownloadUrl.resolve(base, "http://evil.example/a.apk")) // cleartext to a public host
        // Other schemes are not absolute http(s) links: they can only become a path on the paired server.
        assertTrue(DownloadUrl.resolve(base, "file:///sdcard/a.apk")!!.startsWith("http://192.168.1.20:8080/"))
        assertTrue(DownloadUrl.resolve(base, "intent://scan#Intent;end")!!.startsWith("http://192.168.1.20:8080/"))
        assertNull(DownloadUrl.resolve(base, "  "))
        assertNull(DownloadUrl.resolve("http://evil.example", "/a.apk")) // an unusable base stays refused
    }
}
