package org.tix.checkin.core.scan

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.tix.checkin.core.contract.DEFAULT_WARNING_PRIORITY
import org.tix.checkin.core.contract.Manifest
import org.tix.checkin.core.contract.ManifestResultColors
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.ScannerJson

class ResultStyleTest {
    private val p = ResultPalette.DEFAULT
    private fun rgb(hex: String) = ResultPalette.parseHex(hex)!!

    @Test
    fun `defaults`() {
        assertEquals(rgb("#16A34A"), p.accepted)
        assertEquals(rgb("#DC2626"), p.rejected)
        assertEquals(rgb("#FACC15"), p.colorOf(ScanWarning.DISCOUNT_PROOF_REQUIRED))
        assertEquals(rgb("#14B8A6"), p.colorOf(ScanWarning.SEAT_FEATURE))
        assertEquals(rgb("#2563EB"), p.colorOf(ScanWarning.WRONG_ENTRANCE))
        assertEquals(rgb("#F97316"), p.colorOf(ScanWarning.ADDITIONAL_PAYMENT_OPEN))
        assertEquals(DEFAULT_WARNING_PRIORITY, p.priority)
    }

    @Test
    fun `rejected, missing result and unknown result use the rejected colour`() {
        for (r in listOf(ScanResult.REJECTED_ALREADY_CHECKED_IN, ScanResult.REJECTED_UNKNOWN_TICKET, ScanResult.UNKNOWN, null)) {
            val s = p.style(r, listOf(ScanWarning.SEAT_FEATURE))
            assertEquals(p.rejected, s.background, r?.name)
            assertNull(s.lead)
            assertTrue(s.others.isEmpty())
        }
    }

    @Test
    fun `accepted without warnings is the accepted colour`() {
        val s = p.style(ScanResult.ACCEPTED, emptyList())
        assertEquals(p.accepted, s.background)
        assertNull(s.lead)
    }

    @Test
    fun `highest priority warning decides the background, the others become chips in priority order`() {
        val all = listOf(ScanWarning.SEAT_FEATURE, ScanWarning.ADDITIONAL_PAYMENT_OPEN, ScanWarning.WRONG_ENTRANCE, ScanWarning.DISCOUNT_PROOF_REQUIRED)
        val s = p.style(ScanResult.ACCEPTED_WITH_WARNING, all)
        assertEquals(ScanWarning.DISCOUNT_PROOF_REQUIRED, s.lead)
        assertEquals(rgb("#FACC15"), s.background)
        assertEquals(listOf(ScanWarning.WRONG_ENTRANCE, ScanWarning.ADDITIONAL_PAYMENT_OPEN, ScanWarning.SEAT_FEATURE), s.others.map { it.warning })
        assertEquals(rgb("#2563EB"), s.others.first().color)
    }

    @Test
    fun `custom priority is honoured, unknown and duplicate codes dropped, missing codes appended`() {
        val custom = ResultPalette(
            priority = listOf(ScanWarning.SEAT_FEATURE, ScanWarning.UNKNOWN, ScanWarning.SEAT_FEATURE, ScanWarning.WRONG_ENTRANCE),
        )
        assertEquals(
            listOf(ScanWarning.SEAT_FEATURE, ScanWarning.WRONG_ENTRANCE, ScanWarning.DISCOUNT_PROOF_REQUIRED, ScanWarning.ADDITIONAL_PAYMENT_OPEN),
            custom.priority,
        )
        val s = custom.style(ScanResult.ACCEPTED_WITH_WARNING, listOf(ScanWarning.DISCOUNT_PROOF_REQUIRED, ScanWarning.SEAT_FEATURE))
        assertEquals(ScanWarning.SEAT_FEATURE, s.lead)
    }

    @Test
    fun `an unknown warning of a newer server is still shown`() {
        val s = p.style(ScanResult.ACCEPTED_WITH_WARNING, listOf(ScanWarning.UNKNOWN))
        assertEquals(ScanWarning.UNKNOWN, s.lead)
        val both = p.style(ScanResult.ACCEPTED_WITH_WARNING, listOf(ScanWarning.UNKNOWN, ScanWarning.SEAT_FEATURE))
        assertEquals(ScanWarning.SEAT_FEATURE, both.lead)
        assertEquals(listOf(ScanWarning.UNKNOWN), both.others.map { it.warning })
    }

    @Test
    fun `hex parsing - 6 and 8 digits, case-insensitive, invalid falls back to the default per key`() {
        assertEquals(0xFF112233.toInt(), ResultPalette.parseHex("#112233"))
        assertEquals(0xFF112233.toInt(), ResultPalette.parseHex("#112233cc")) // alpha ignored, never crashes
        assertEquals(0xFFAABBCC.toInt(), ResultPalette.parseHex(" #aabbcc "))
        for (bad in listOf("", "red", "#123", "112233", "#12345", "#1234567", "#GG0000", "#112233445")) assertNull(ResultPalette.parseHex(bad), bad)
        val pal = ResultPalette(ManifestResultColors(accepted = "nope", rejected = "#010203", seatFeature = "#FFFFFFFF"))
        assertEquals(rgb("#16A34A"), pal.accepted)
        assertEquals(rgb("#010203"), pal.rejected)
        assertEquals(rgb("#FFFFFF"), pal.colorOf(ScanWarning.SEAT_FEATURE))
    }

    @Test
    fun `luminance rule is the one of the admin preview - black on green, yellow, turquoise, orange, white on red and blue`() {
        // Same WCAG formula and 0.179 threshold as readableTextColor (packages/shared/src/scanner/colors.ts).
        assertTrue(Luminance.prefersDarkText(rgb("#FACC15")))
        assertTrue(Luminance.prefersDarkText(rgb("#14B8A6")))
        assertTrue(Luminance.prefersDarkText(rgb("#F97316")))
        assertTrue(Luminance.prefersDarkText(rgb("#16A34A")), "default green is light enough for black text (luminance ~0.27)")
        assertFalse(Luminance.prefersDarkText(rgb("#DC2626")))
        assertFalse(Luminance.prefersDarkText(rgb("#2563EB")))
        assertTrue(Luminance.prefersDarkText(rgb("#FFFFFF")))
        assertFalse(Luminance.prefersDarkText(rgb("#000000")))
        assertEquals(0.2684, Luminance.relative(rgb("#16A34A")), 0.001)
    }

    @Test
    fun `style carries the content colour of its background`() {
        assertFalse(p.style(ScanResult.REJECTED_TICKET_VOID, emptyList()).darkContent)
        assertTrue(p.style(ScanResult.ACCEPTED_WITH_WARNING, listOf(ScanWarning.DISCOUNT_PROOF_REQUIRED)).darkContent)
        assertFalse(p.style(ScanResult.ACCEPTED_WITH_WARNING, listOf(ScanWarning.WRONG_ENTRANCE)).darkContent)
    }

    @Test
    fun `stored json round trip and tolerant reading`() {
        val colors = ManifestResultColors(accepted = "#00FF00", wrongEntrance = "#0000FF11")
        val json = ResultPalette.encode(colors, listOf(ScanWarning.WRONG_ENTRANCE))
        val pal = ResultPalette.fromJson(json)
        assertEquals(rgb("#00FF00"), pal.accepted)
        assertEquals(ScanWarning.WRONG_ENTRANCE, pal.priority.first())
        for (bad in listOf(null, "", "   ", "{not json", "[]")) assertEquals(p.accepted, ResultPalette.fromJson(bad).accepted)
    }

    @Test
    fun `manifest without the optional fields decodes to defaults, with them to the server values`() {
        fun manifest(settings: String) = ScannerJson.decodeFromString<Manifest>(
            """{"apiVersion":1,"serverTime":"2026-11-10T10:00:00.000Z","etag":"e","device":{"id":"d","name":"n"},"settings":$settings,"events":[]}""",
        )
        val old = manifest("""{"offlineModeAllowed":true,"lanSyncEnabled":false,"syncIntervalSeconds":30}""")
        assertEquals(ManifestResultColors(), old.settings.resultColors)
        assertEquals(DEFAULT_WARNING_PRIORITY, old.settings.warningPriority)

        val m = manifest(
            """{"offlineModeAllowed":true,"lanSyncEnabled":true,"syncIntervalSeconds":30,
               "resultColors":{"accepted":"#16A34A","rejected":"#DC2626","discountProof":"#FACC15","seatFeature":"#14B8A6","wrongEntrance":"#2563EB","additionalPaymentOpen":"#F97316FF"},
               "warningPriority":["SEAT_FEATURE","FUTURE_CODE","DISCOUNT_PROOF_REQUIRED","WRONG_ENTRANCE","ADDITIONAL_PAYMENT_OPEN"]}""",
        )
        assertEquals("#F97316FF", m.settings.resultColors.additionalPaymentOpen)
        val pal = ResultPalette(m.settings.resultColors, m.settings.warningPriority)
        assertEquals(ScanWarning.SEAT_FEATURE, pal.priority.first())
        assertEquals(rgb("#F97316"), pal.colorOf(ScanWarning.ADDITIONAL_PAYMENT_OPEN))
    }
}
