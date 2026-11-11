package org.tix.checkin.core.scan

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import org.tix.checkin.core.contract.DEFAULT_WARNING_PRIORITY
import org.tix.checkin.core.contract.ManifestResultColors
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.ScannerJson

/** What is persisted of the manifest's colour settings (one JSON text in the device config row). */
@Serializable
data class StoredResultStyle(
    val resultColors: ManifestResultColors = ManifestResultColors(),
    val warningPriority: List<ScanWarning> = DEFAULT_WARNING_PRIORITY,
)

/** A warning shown as a chip: its own colour, text colour chosen by luminance. */
data class WarningChip(val warning: ScanWarning, val color: Int, val darkContent: Boolean)

/**
 * Look of a result screen. Colours are opaque ARGB ints. [lead] is the warning that decided [background]
 * (null for plain accepted / rejected); [others] are the remaining warnings, in priority order.
 */
data class ResultStyle(
    val background: Int,
    /** true = black text/icons (light background), false = white. */
    val darkContent: Boolean,
    val lead: ScanWarning?,
    val others: List<WarningChip>,
)

/** WCAG relative luminance, identical to `readableTextColor` of packages/shared/src/scanner/colors.ts. */
object Luminance {
    const val DARK_TEXT_THRESHOLD = 0.179

    fun relative(argb: Int): Double {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF) / 255.0
            return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    /** true = black text reads better on [argb]. */
    fun prefersDarkText(argb: Int): Boolean = relative(argb) > DARK_TEXT_THRESHOLD
}

/** Resolved screen colours + warning priority of the server (defaults for anything missing or invalid). */
class ResultPalette(colors: ManifestResultColors = ManifestResultColors(), priority: List<ScanWarning> = DEFAULT_WARNING_PRIORITY) {
    private val defaults = ManifestResultColors()
    val accepted = hex(colors.accepted, defaults.accepted)
    val rejected = hex(colors.rejected, defaults.rejected)
    private val discountProof = hex(colors.discountProof, defaults.discountProof)
    private val seatFeature = hex(colors.seatFeature, defaults.seatFeature)
    private val wrongEntrance = hex(colors.wrongEntrance, defaults.wrongEntrance)
    private val additionalPaymentOpen = hex(colors.additionalPaymentOpen, defaults.additionalPaymentOpen)

    /** Known codes only, no duplicates; codes the server left out follow in the default order. */
    val priority: List<ScanWarning> =
        (priority.filter { it != ScanWarning.UNKNOWN } + DEFAULT_WARNING_PRIORITY).distinct()

    /** A warning this app does not know (newer server) is shown in the proof colour: yellow = "look at this". */
    fun colorOf(w: ScanWarning): Int = when (w) {
        ScanWarning.DISCOUNT_PROOF_REQUIRED -> discountProof
        ScanWarning.WRONG_ENTRANCE -> wrongEntrance
        ScanWarning.ADDITIONAL_PAYMENT_OPEN -> additionalPaymentOpen
        ScanWarning.SEAT_FEATURE -> seatFeature
        ScanWarning.UNKNOWN -> discountProof
    }

    /** Rejected (and a missing/unknown result) -> rejected colour; accepted -> first warning by priority, else accepted. */
    fun style(result: ScanResult?, warnings: List<ScanWarning>): ResultStyle {
        if (result == null || !result.isAccepted) return plain(rejected)
        val present = (priority.filter { it in warnings } + warnings.filter { it !in priority }).distinct()
        val lead = present.firstOrNull() ?: return plain(accepted)
        val bg = colorOf(lead)
        return ResultStyle(
            background = bg,
            darkContent = Luminance.prefersDarkText(bg),
            lead = lead,
            others = present.drop(1).map { WarningChip(it, colorOf(it), Luminance.prefersDarkText(colorOf(it))) },
        )
    }

    private fun plain(bg: Int) = ResultStyle(bg, Luminance.prefersDarkText(bg), null, emptyList())

    companion object {
        // Declared before DEFAULT: the constructor of DEFAULT already parses colours with it.
        private val HEX = Regex("#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?")

        val DEFAULT = ResultPalette()

        fun encode(colors: ManifestResultColors, priority: List<ScanWarning>): String =
            ScannerJson.encodeToString(StoredResultStyle(colors, priority))

        /** Never throws: null / unreadable JSON gives the defaults. */
        fun fromJson(json: String?): ResultPalette {
            if (json.isNullOrBlank()) return DEFAULT
            return try {
                val s = ScannerJson.decodeFromString<StoredResultStyle>(json)
                ResultPalette(s.resultColors, s.warningPriority)
            } catch (_: Exception) {
                DEFAULT
            }
        }

        /** `#RRGGBB` or `#RRGGBBAA` -> opaque ARGB (the alpha part is ignored); anything else -> [fallback] text parsed the same way. */
        fun parseHex(text: String): Int? {
            val m = HEX.matchEntire(text.trim()) ?: return null
            return (0xFF000000L or m.groupValues[1].toLong(16)).toInt()
        }

        private fun hex(text: String, fallback: String): Int = parseHex(text) ?: parseHex(fallback)!!
    }
}
