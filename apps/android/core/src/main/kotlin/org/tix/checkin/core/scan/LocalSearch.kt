package org.tix.checkin.core.scan

import org.tix.checkin.core.TicketCode

/** Offline manual search over the local tickets (online search is the server's `/lookup`). */
object LocalSearch {
    /** Lower-cased words of a query. */
    fun tokens(query: String): List<String> =
        query.lowercase().split(Regex("[\\s,;/]+")).filter { it.isNotEmpty() }

    /** Text a ticket is searched in (name, ticket code incl. typo variants, block, row, seat). */
    fun haystack(t: LocalTicket): String =
        listOfNotNull(t.attendeeName, t.ticketCode, TicketCode.format(t.ticketCode), t.sectionLabel, t.rowLabel, t.seatLabel)
            .joinToString(" ").lowercase()

    /**
     * Name/code words match as substrings (also in the middle of a word). Seat words (block, row,
     * seat) must match a whole word, like on the server: "3" must not hit row "13".
     */
    fun matches(t: LocalTicket, tokens: List<String>): Boolean {
        if (tokens.isEmpty()) return false
        val name = t.attendeeName.orEmpty().lowercase()
        val code = t.ticketCode.lowercase()
        val seatWords = (t.sectionLabel.lowercase().split(Regex("\\s+")) +
            listOfNotNull(t.rowLabel, t.seatLabel).map { it.lowercase() }).filter { it.isNotEmpty() }
        return tokens.all { tok ->
            name.contains(tok) || (tok.length >= 4 && code.contains(TicketCode.normalize(tok).lowercase())) || tok in seatWords
        }
    }
}
