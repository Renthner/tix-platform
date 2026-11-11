package org.tix.checkin.core

/**
 * Suppresses repeats of the same code while the camera keeps seeing it. The window is per code
 * and slides on every sighting: a code is reported again only after it was not seen for
 * [windowMillis]. Not thread-safe; call it from one thread (the analyzer callback).
 */
class ScanDebouncer(
    private val windowMillis: Long = 2_000,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val lastSeen = HashMap<String, Long>()

    /** Returns true when [code] should be handled, false when it is a repeat. */
    fun accept(code: String): Boolean {
        val now = clock()
        if (lastSeen.size > 64) lastSeen.entries.removeAll { now - it.value > windowMillis }
        val previous = lastSeen[code]
        lastSeen[code] = now
        return previous == null || now - previous > windowMillis
    }

    fun reset() = lastSeen.clear()
}
