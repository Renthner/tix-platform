package org.tix.checkin.data

import org.tix.checkin.core.scan.LocalSearch
import org.tix.checkin.core.scan.LocalTicket

/**
 * Offline attendee search for 10k+ tickets. Candidates come from indexes only (never a `LIKE '%x%'` scan):
 *
 * - the FTS4 index over the folded `searchText` (name, code, block, row, seat, order number); the typed words are
 *   folded the same way ([LocalSearch.fold]), so "soren" finds "Søren" and "muller" finds "Müller";
 * - words of 3+ characters: prefix terms for all words, plus an index range scan on the ticket code for every word that
 *   looks like a code (exact code / code start, also typed with dashes or O/0 typos);
 * - words of 1-2 characters only (a one-letter prefix would match half the index): TWO cheap full-text queries, one with
 *   every word as a whole-word term (seat lookups "b 7", "a 12", the surname "li" of "Wei Li") and one where 2-letter
 *   words are prefixes and 1-letter words stay whole ("oz" finds Özdemir), plus the code range scan.
 *
 * [LocalSearch.matches] then applies the exact rule to all words and [LocalSearch.sorted] ranks the hits.
 */
class TicketSearch(private val dao: TixDao) {
    suspend fun search(eventId: String, query: String, limit: Int = 50): List<LocalTicket> {
        val tokens = LocalSearch.tokens(query)
        if (tokens.isEmpty()) return emptyList()
        val longest = tokens.maxBy { it.length }
        val candidates = LinkedHashMap<String, TicketEntity>()
        fun add(rows: List<TicketEntity>) = rows.forEach { candidates.putIfAbsent(it.id, it) }

        if (longest.length <= SHORT) {
            LocalSearch.ftsWholeQuery(tokens)?.let { add(dao.searchFts(eventId, it, SHORT_LIMIT)) }
            LocalSearch.ftsMixedQuery(tokens, SHORT)?.let { add(dao.searchFts(eventId, it, SHORT_LIMIT)) }
            val code = LocalSearch.codeOf(longest, LocalSearch.codeMin(tokens.size)) // codes are stored normalised (O -> 0 ...)
            if (code.isNotEmpty()) add(dao.ticketsByCodeRange(eventId, code, end(code), SHORT_LIMIT))
        } else {
            LocalSearch.ftsQuery(tokens)?.let { add(dao.searchFts(eventId, it, CANDIDATES)) }
            for (tok in tokens) {
                val code = LocalSearch.codeOf(tok, LocalSearch.codeMin(tokens.size))
                if (code.isNotEmpty()) add(dao.ticketsByCodeRange(eventId, code, end(code), CANDIDATES))
            }
        }
        val hits = candidates.values.map { it.toLocal() }.filter { LocalSearch.matches(it, tokens) }
        return LocalSearch.sorted(hits, tokens).take(limit)
    }

    private fun end(prefix: String) = LocalSearch.prefixEnd(prefix)

    companion object {
        /** Words up to this length use the whole-word / short-prefix queries. */
        const val SHORT = 2
        private const val SHORT_LIMIT = 200
        private const val CANDIDATES = 400
    }
}
