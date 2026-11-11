package org.tix.checkin.core

/** Human-readable ticket code helpers (port of `formatTicketCode` / `normalizeTicketCode`). */
object TicketCode {
    /** Display form of a stored code (`ABCDEFGHJK` -> `ABCDE-FGHJK`). */
    fun format(code: String): String =
        if (code.length == 10) "${code.substring(0, 5)}-${code.substring(5)}" else code

    /** Normalises manual input (case, whitespace, dashes, Crockford aliases O->0, I/L->1). */
    fun normalize(input: String): String =
        input.uppercase()
            .replace(Regex("[\\s-]+"), "")
            .replace('O', '0')
            .replace(Regex("[IL]"), "1")
}
