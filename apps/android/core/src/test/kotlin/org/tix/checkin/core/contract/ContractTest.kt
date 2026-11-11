package org.tix.checkin.core.contract

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.tix.checkin.core.Pairing

/** DTO (de)serialization against the JSON examples of docs/SCANNER.md. */
class ContractTest {
    private val json = ScannerJson

    @Test
    fun `decodes the pair response`() {
        val r = json.decodeFromString<PairResponse>(
            """{ "apiVersion": 1, "deviceId": "8d0c9d9c-5f0a-4d50-9a5b-0e1f2a3b4c5d", "deviceName": "Door A",
                 "token": "tixd_abc", "serverTime": "2026-11-10T18:00:00+01:00" }""",
        )
        assertEquals("tixd_abc", r.token)
        assertEquals(1, r.apiVersion)
    }

    @Test
    fun `decodes the manifest`() {
        val m = json.decodeFromString<Manifest>(
            """{
              "apiVersion": 1, "serverTime": "2026-11-10T18:00:00Z", "etag": "abc123", "syncEpoch": "ep-1",
              "device": { "id": "d1", "name": "Door A" },
              "settings": { "offlineModeAllowed": true, "lanSyncEnabled": true, "syncIntervalSeconds": 30 },
              "events": [ {
                "id": "e1", "title": "Show", "subtitle": null, "startsAt": "2026-11-10T20:00:00+01:00",
                "doorsOpenAt": null, "endsAt": null, "timeZone": "Europe/Berlin", "venueName": "Hall",
                "entranceId": "n1", "allowCheckOut": true,
                "keys": [ { "keyId": "ab12cd34", "status": "ACTIVE", "publicKey": "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg" },
                          { "keyId": "dead0000", "status": "REVOKED", "publicKey": null } ],
                "ticketTypes": [ { "id": "t1", "name": "Reduced", "requiresProof": true, "scannerWarning": "Check proof" } ],
                "categories": [ { "id": "c1", "name": "Cat 1", "color": "#336699" } ],
                "entrances": [ { "id": "n1", "name": "North", "code": "N" } ],
                "sections": [ { "id": "s1", "name": "Stalls", "entranceId": null } ],
                "lan": { "enabled": true, "secret": null },
                "futureField": 1
              } ]
            }""",
        )
        assertEquals("abc123", m.etag)
        assertEquals("ep-1", m.syncEpoch)
        assertEquals(30, m.settings.syncIntervalSeconds)
        val e = m.events.single()
        assertEquals(KeyStatus.REVOKED, e.keys[1].status)
        assertNull(e.keys[1].publicKey)
        assertTrue(e.ticketTypes.single().requiresProof)
        assertNull(e.sections.single().entranceId)
        assertTrue(e.lan.enabled)
    }

    @Test
    fun `decodes a sync page with tombstones`() {
        val p = json.decodeFromString<SyncPage>(
            """{ "tickets": [ {
                 "id": "t1", "ticketCode": "ABCDEFGHJK", "status": "REPLACED", "eventId": "e1", "keyId": "ab12cd34",
                 "sectionId": "s1", "sectionLabel": "Stalls", "rowLabel": "B", "seatLabel": "7",
                 "seatFeature": "WHEELCHAIR_SPACE", "categoryId": "c1", "categoryName": "Cat 1", "ticketTypeId": "tt",
                 "attendeeName": "Max Muster", "checkInState": "CHECKED_OUT", "firstCheckedInAt": "2026-11-10T18:00:00Z",
                 "firstCheckedInDeviceName": "Door A", "checkInCount": 1, "lastScanAt": null,
                 "additionalPaymentOpen": false, "syncVersion": 12345 } ],
               "nextCursor": "c-12345", "hasMore": false, "serverTime": "2026-11-10T18:00:00Z", "syncEpoch": "ep1" }""",
        )
        val t = p.tickets.single()
        assertEquals(TicketStatus.REPLACED, t.status)
        assertEquals(SeatFeature.WHEELCHAIR_SPACE, t.seatFeature)
        assertEquals(CheckInState.CHECKED_OUT, t.checkInState)
        assertEquals("c-12345", p.nextCursor)
        assertEquals("ep1", p.syncEpoch)
        assertEquals(12345L, t.syncVersion)
    }

    @Test
    fun `decodes a scan outcome`() {
        val o = json.decodeFromString<ScanOutcome>(
            """{ "clientScanId": "c1", "result": "ACCEPTED_WITH_WARNING", "color": "YELLOW",
                 "warnings": ["DISCOUNT_PROOF_REQUIRED"], "warningTexts": { "DISCOUNT_PROOF_REQUIRED": "Bitte pruefen" },
                 "duplicate": false, "recorded": true,
                 "ticket": { "id": "t1", "ticketCode": "ABCDEFGHJK", "status": "VALID", "attendeeName": "Max",
                             "categoryName": "Cat 1", "ticketTypeName": "Reduced", "sectionLabel": "Stalls",
                             "rowLabel": "B", "seatLabel": "7", "seatFeature": null, "checkInState": "CHECKED_IN" },
                 "firstScan": { "at": "2026-11-10T18:00:00Z", "deviceName": "Door A" } }""",
        )
        assertEquals(ScanResult.ACCEPTED_WITH_WARNING, o.result)
        assertEquals(ScanColor.YELLOW, o.color)
        assertEquals("Bitte pruefen", o.warningTexts["DISCOUNT_PROOF_REQUIRED"])
        assertEquals("Door A", o.firstScan?.deviceName)
        assertNull(o.ticket?.seatFeature)
    }

    @Test
    fun `decodes a batch response and lookup and latest`() {
        val b = json.decodeFromString<ScanBatchResponse>(
            """{ "results": [ { "clientScanId": "c1", "result": "REJECTED_ALREADY_CHECKED_IN", "color": "RED", "warnings": [],
                 "warningTexts": {}, "duplicate": true, "recorded": true, "ticket": null, "firstScan": null } ],
                 "serverTime": "2026-11-10T18:00:00Z" }""",
        )
        assertTrue(b.results.single().duplicate)
        val l = json.decodeFromString<LookupResponse>(
            """{ "tickets": [ { "id": "t1", "ticketCode": "ABCDEFGHJK", "status": "VALID", "attendeeName": null,
                 "categoryName": "Cat 1", "ticketTypeName": "Normal", "sectionLabel": "Stalls", "rowLabel": null,
                 "seatLabel": null, "seatFeature": null, "checkInState": "NONE", "orderNumber": "2026-1",
                 "buyerName": "Erika", "firstCheckedInAt": null } ] }""",
        )
        assertEquals("2026-1", l.tickets.single().orderNumber)
        val a = json.decodeFromString<AppLatest>(
            """{ "versionName": "1.2.0", "versionCode": 12, "sha256": "ff", "sizeBytes": 1234, "notes": null,
                 "downloadUrl": "http://192.168.1.20:8080/api/scanner/v1/app/download?t=x", "downloadUrlTtlSeconds": 3600 }""",
        )
        assertEquals(12, a.versionCode)
    }

    @Test
    fun `unknown enum values degrade instead of failing`() {
        val o = json.decodeFromString<ScanOutcome>(
            """{ "clientScanId": "c1", "result": "REJECTED_BRAND_NEW", "color": "PURPLE",
                 "warnings": ["SOMETHING_NEW"], "warningTexts": {}, "duplicate": false, "recorded": true,
                 "ticket": { "id": "t", "status": "EXPLODED", "checkInState": "NONE" }, "firstScan": null }""",
        )
        assertEquals(ScanResult.UNKNOWN, o.result)
        assertFalse(o.result.isAccepted)
        assertEquals(ScanColor.RED, o.color)
        assertEquals(listOf(ScanWarning.UNKNOWN), o.warnings)
        assertEquals(TicketStatus.UNKNOWN, o.ticket?.status)
    }

    @Test
    fun `a camera scan request carries no null keys`() {
        val text = json.encodeToString(
            ScanRequest(
                clientScanId = "3b0c9d9c-5f0a-4d50-9a5b-0e1f2a3b4c5d", eventId = "e1", action = ScanAction.CHECK_IN,
                source = ScanSource.CAMERA, payload = "tix://v1/x", scannedAt = "2026-11-10T18:00:00Z",
            ),
        )
        assertFalse(text.contains("null"), text)
        assertFalse(text.contains("ticketId"))
        assertFalse(text.contains("ticketCode"))
        assertFalse(text.contains("entranceId"))
        assertTrue(text.contains("\"action\":\"CHECK_IN\""))
        assertTrue(text.contains("\"source\":\"CAMERA\""))
    }

    @Test
    fun `parses the pairing qr uri`() {
        val t = Pairing.parseUri("tixscan://pair?v=1&u=http%3A%2F%2F192.168.1.20%3A8080&c=ABCDEFGHJK")
        assertEquals(Pairing.Target("http://192.168.1.20:8080", "ABCDEFGHJK"), t)
        assertNull(Pairing.parseUri("https://example.org"))
        assertNull(Pairing.parseUri("tixscan://pair?v=2&u=x&c=ABCDEFGHJK"))
        assertNull(Pairing.parseUri("tixscan://pair?v=1&u=x&c=SHORT"))
        assertEquals("ABCDEFGHJK", Pairing.normalizeCode(" abcde-fghjk "))
        assertEquals("01110", Pairing.normalizeCode("o1l-I0"))
        assertEquals("ABCDE-FGHJK", Pairing.formatCode("ABCDEFGHJK"))
    }

    @Test
    fun `timestamps always carry seconds`() {
        assertEquals("2026-11-10T17:00:00Z", Iso.format(Iso.parseMillis("2026-11-10T18:00:00+01:00")!!))
        assertNull(Iso.parseMillis("garbage"))
    }

    @Test
    fun `every server result and warning value exists in the app`() {
        val results = listOf(
            "ACCEPTED", "ACCEPTED_WITH_WARNING", "REJECTED_ALREADY_CHECKED_IN", "REJECTED_NOT_CHECKED_IN",
            "REJECTED_INVALID_SIGNATURE", "REJECTED_WRONG_EVENT", "REJECTED_TICKET_VOID", "REJECTED_UNKNOWN_TICKET",
            "REJECTED_MALFORMED", "REJECTED_CHECK_OUT_NOT_ALLOWED",
        )
        for (r in results) {
            val o = json.decodeFromString<ScanOutcome>(
                """{ "clientScanId": "c", "result": "$r", "color": "RED", "warnings": [], "warningTexts": {},
                     "duplicate": false, "recorded": true, "ticket": null, "firstScan": null }""",
            )
            assertEquals(r, o.result.name)
        }
        val w = json.decodeFromString<ScanOutcome>(
            """{ "clientScanId": "c", "result": "ACCEPTED_WITH_WARNING", "color": "YELLOW",
                 "warnings": ["DISCOUNT_PROOF_REQUIRED","WRONG_ENTRANCE","SEAT_FEATURE","ADDITIONAL_PAYMENT_OPEN"],
                 "warningTexts": {}, "duplicate": false, "recorded": true, "ticket": null, "firstScan": null }""",
        )
        assertEquals(
            listOf(ScanWarning.DISCOUNT_PROOF_REQUIRED, ScanWarning.WRONG_ENTRANCE, ScanWarning.SEAT_FEATURE, ScanWarning.ADDITIONAL_PAYMENT_OPEN),
            w.warnings,
        )
    }

    @Test
    fun `a batch request carries sentAt and scans`() {
        val text = json.encodeToString(
            ScanBatchRequest(
                scans = listOf(
                    ScanRequest(
                        clientScanId = "3b0c9d9c-5f0a-4d50-9a5b-0e1f2a3b4c5d", eventId = "e1", action = ScanAction.CHECK_OUT,
                        source = ScanSource.MANUAL, ticketId = "t1", scannedAt = "2026-11-10T18:00:00Z",
                    ),
                ),
                sentAt = "2026-11-10T18:05:00Z",
            ),
        )
        assertTrue(text.contains("\"sentAt\":\"2026-11-10T18:05:00Z\""), text)
        assertTrue(text.contains("\"scans\":["), text)
        assertFalse(text.contains("since"))
    }

    @Test
    fun `api exception flags`() {
        assertTrue(ApiException(503, "MAINTENANCE", "restore", 60).isMaintenance)
        val missing = ApiException(503, "SERVER_URL_MISSING", "no url")
        assertTrue(missing.isServerUrlMissing)
        assertFalse(missing.isMaintenance)
        assertTrue(ApiException(401, "DEVICE_REVOKED", "x").isUnauthorized)
        assertTrue(ApiException(403, "EVENT_NOT_ASSIGNED", "x").isEventNotAssigned)
    }

    @Test
    fun `decodes the error body`() {
        val e = json.decodeFromString<ApiError>("""{ "error": "RATE_LIMITED", "message": "Too many", "details": { "x": 1 } }""")
        assertEquals("RATE_LIMITED", e.error)
    }
}
