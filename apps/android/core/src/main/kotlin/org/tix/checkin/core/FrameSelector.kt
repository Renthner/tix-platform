package org.tix.checkin.core

/** What one camera frame means for check-in. */
sealed interface FrameSelection {
    /** No readable code in the frame. */
    data object None : FrameSelection

    /** Exactly one distinct code: handle it (the debouncer decides whether it is a repeat). */
    data class Single(val code: String) : FrameSelection

    /** Two or more different codes: ambiguous, book none and tell the operator to scan one ticket at a time. */
    data object Multiple : FrameSelection
}

/**
 * Picks what to book from the barcodes of ONE frame. The same value seen twice in a frame (two detections of one
 * code) is one code. There is deliberately no state here: no cooldown, a rescan after the verdict always works.
 */
object FrameSelector {
    fun select(values: List<String?>): FrameSelection {
        val distinct = values.filterNotNull().filter { it.isNotBlank() }.distinct()
        return when (distinct.size) {
            0 -> FrameSelection.None
            1 -> FrameSelection.Single(distinct[0])
            else -> FrameSelection.Multiple
        }
    }
}
