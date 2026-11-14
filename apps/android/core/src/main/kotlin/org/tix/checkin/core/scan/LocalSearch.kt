package org.tix.checkin.core.scan

import java.text.Normalizer
import org.tix.checkin.core.TicketCode
import org.tix.checkin.core.contract.TicketStatus

/**
 * Offline manual search over the local tickets (online search is the server's `/lookup`).
 *
 * Matching is by word prefix (what a full-text index can answer): every typed word must start a word of the
 * attendee name or the ticket code, or equal a whole seat word (block, row, seat) like on the server: "3" must not
 * hit row "13". The order number (`TIX-2026-000123`) is found by its trailing words ([orderMatch]): "000123",
 * "2026-000123" or the whole number. Case and diacritics are ignored ("muller" finds "Müller", "soren" finds
 * "Søren"): [fold] is applied to the typed words AND to the indexed text ([indexText], stored in the `searchText`
 * column the full-text index is built on), so the database and [matches] agree. The database narrows the candidates
 * ([ftsQuery], [ftsWholeQuery], code ranges), [matches] is the exact filter and [rank] the order.
 */
object LocalSearch {
    /** Minimum normalised length from which a typed word is also tried as (the start of) a ticket code. */
    const val CODE_MIN = 4

    /** Shortest typed order-number part that counts as an order number hit ("12" is a seat, not an order). */
    const val ORDER_MIN = 3

    private val DIACRITICS = Regex("\\p{M}+")
    private val NON_ALNUM = Regex("[^\\p{L}\\p{N}]+")

    /**
     * Letters that have no canonical decomposition (so NFD cannot strip anything) but are written as plain Latin
     * letters by users without that keyboard.
     */
    private val SPECIAL = mapOf(
        'ø' to "o", 'æ' to "ae", 'œ' to "oe", 'ß' to "ss", 'ł' to "l", 'đ' to "d", 'ð' to "d", 'þ' to "th", 'ı' to "i", 'ħ' to "h",
    )

    /** Lower case without diacritics (also ø, æ, œ, ß, ł, đ, ð, þ, ı, ħ). */
    fun fold(s: String): String {
        val lower = s.lowercase()
        val mapped = if (lower.any { it in SPECIAL }) buildString { for (c in lower) append(SPECIAL[c] ?: c) } else lower
        return Normalizer.normalize(mapped, Normalizer.Form.NFD).replace(DIACRITICS, "")
    }

    /** The text the full-text index is built on: everything searchable of a ticket, [fold]ed. */
    fun indexText(name: String?, code: String, section: String, row: String?, seat: String?, orderNumber: String?): String =
        fold(listOfNotNull(name, code, section, row, seat, orderNumber).joinToString(" "))

    /** Folded words of a query (separators: whitespace , ; /). A dash stays inside: ticket codes are typed `ABCDE-FGHJK`. */
    fun tokens(query: String): List<String> =
        fold(query).split(Regex("[\\s,;/]+")).filter { it.isNotEmpty() }

    /** Folded alphanumeric words of a text. */
    fun words(text: String?): List<String> = if (text == null) emptyList() else fold(text).split(NON_ALNUM).filter { it.isNotEmpty() }

    /**
     * Shortest typed word tried as the start of a ticket code: any length when it is the only word (the operator types
     * the first characters of a code), [CODE_MIN] when it is one of several (otherwise "b" of "stalls b 7" hits codes).
     */
    fun codeMin(tokenCount: Int): Int = if (tokenCount == 1) 1 else CODE_MIN

    /** Upper-case code form of a typed word (case, dashes, Crockford aliases), "" when shorter than [min]. */
    fun codeOf(token: String, min: Int = CODE_MIN): String = TicketCode.normalize(token).takeIf { it.length >= min } ?: ""

    /**
     * The FTS4 query for the candidates: every alphanumeric part of every word as a prefix term, all must match
     * (any column). null when nothing searchable is left.
     */
    fun ftsQuery(tokens: List<String>): String? {
        val terms = parts(tokens)
        return terms.takeIf { it.isNotEmpty() }?.joinToString(" ") { "$it*" }
    }

    /**
     * Like [ftsQuery] but only parts of at least [minPrefix] characters are prefix terms, shorter ones must equal a
     * whole indexed word (seat "7", row "B", the surname "Li"). null when nothing searchable is left.
     */
    fun ftsMixedQuery(tokens: List<String>, minPrefix: Int = 2): String? {
        val terms = parts(tokens)
        return terms.takeIf { it.isNotEmpty() }?.joinToString(" ") { if (it.length >= minPrefix) "$it*" else it }
    }

    /** Every part must equal a whole indexed word (no prefix): the exact seat / short word lookup ("a 12"). */
    fun ftsWholeQuery(tokens: List<String>): String? = parts(tokens).takeIf { it.isNotEmpty() }?.joinToString(" ")

    private fun parts(tokens: List<String>): List<String> = tokens.flatMap { parts(it) }

    private fun parts(token: String): List<String> = token.split(NON_ALNUM).filter { it.isNotEmpty() }

    /** Text a ticket is searched in (name, ticket code incl. typo variants, block, row, seat, order number). */
    fun haystack(t: LocalTicket): String =
        listOfNotNull(t.attendeeName, t.ticketCode, TicketCode.format(t.ticketCode), t.sectionLabel, t.rowLabel, t.seatLabel, t.orderNumber)
            .joinToString(" ").lowercase()

    const val ORDER_NONE = 0
    const val ORDER_PREFIX = 1
    const val ORDER_EXACT = 2

    /**
     * How the typed word [token] hits an order number given as its folded [orderWords] (`tix`, `2026`, `000123`):
     * the typed parts must be a run of consecutive order words ending with the last typed part at the END of the
     * number ("000123", "2026-000123", "tix-2026-000123") - the leading words alone ("2026", "tix") never match, they
     * would hit every ticket. [ORDER_EXACT] = the run ends at the last word and is typed in full, [ORDER_PREFIX] = the
     * last typed part is the start of the number's last word. The last typed part needs [ORDER_MIN] characters.
     */
    fun orderMatch(orderWords: List<String>, token: String): Int {
        val p = parts(token)
        if (p.isEmpty() || p.size > orderWords.size || p.last().length < ORDER_MIN) return ORDER_NONE
        val n = p.size
        val start = orderWords.size - n // anchored at the end: a run ending at the last word
        for (j in 0 until n - 1) if (orderWords[start + j] != p[j]) return ORDER_NONE
        val last = orderWords.last()
        return when {
            last == p.last() -> ORDER_EXACT
            last.startsWith(p.last()) -> ORDER_PREFIX
            else -> ORDER_NONE
        }
    }

    fun matches(t: LocalTicket, tokens: List<String>): Boolean {
        if (tokens.isEmpty()) return false
        val nameWords = words(t.attendeeName)
        val code = t.ticketCode.uppercase()
        val seatWords = words(t.sectionLabel) + words(t.rowLabel) + words(t.seatLabel)
        val orderWords = words(t.orderNumber)
        val codeMin = codeMin(tokens.size)
        // The whole query typed as an order number with spaces ("tix 2026 000123").
        if (tokens.size > 1 && orderMatch(orderWords, tokens.joinToString(" ")) != ORDER_NONE) return true
        return tokens.all { tok ->
            val parts = parts(tok)
            val nameHit = parts.isNotEmpty() && parts.all { p -> nameWords.any { it.startsWith(p) } }
            val codeHit = codeOf(tok, codeMin).let { it.isNotEmpty() && code.startsWith(it) }
            nameHit || codeHit || tok in seatWords || orderMatch(orderWords, tok) != ORDER_NONE
        }
    }

    /**
     * Order of the hits (smaller = earlier): 0 exact ticket code or exact order number / 1 ticket code start or order
     * number start / 2 attendee name / 3 seat only. Within a rank: valid tickets first, then by name (see [sorted]).
     */
    fun rank(t: LocalTicket, tokens: List<String>): Int {
        val code = t.ticketCode.uppercase()
        val codes = tokens.map { codeOf(it, codeMin(tokens.size)) }.filter { it.isNotEmpty() }
        val orderWords = words(t.orderNumber)
        val orderHits = tokens.map { orderMatch(orderWords, it) } + orderMatch(orderWords, tokens.joinToString(" "))
        if (code in codes || ORDER_EXACT in orderHits) return 0
        if (codes.any { code.startsWith(it) } || ORDER_PREFIX in orderHits) return 1
        val nameWords = words(t.attendeeName)
        val nameHit = tokens.any { tok -> parts(tok).let { ps -> ps.isNotEmpty() && ps.all { p -> nameWords.any { it.startsWith(p) } } } }
        return if (nameHit) 2 else 3
    }

    /** Sorts [hits] by [rank], valid first, then name. */
    fun sorted(hits: List<LocalTicket>, tokens: List<String>): List<LocalTicket> =
        hits.sortedWith(
            compareBy<LocalTicket>({ rank(it, tokens) }, { it.status != TicketStatus.VALID }, { it.attendeeName?.let(::fold).orEmpty() }),
        )

    /** The smallest string greater than every string starting with [prefix] (exclusive upper bound of a range scan). */
    fun prefixEnd(prefix: String): String = if (prefix.isEmpty()) "" else prefix.dropLast(1) + (prefix.last() + 1)
}
