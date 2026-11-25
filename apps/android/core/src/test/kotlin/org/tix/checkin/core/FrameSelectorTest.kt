package org.tix.checkin.core

import kotlin.test.Test
import kotlin.test.assertEquals

class FrameSelectorTest {
    @Test
    fun `two distinct codes book none`() {
        assertEquals(FrameSelection.Multiple, FrameSelector.select(listOf("a", "b")))
        assertEquals(FrameSelection.Multiple, FrameSelector.select(listOf("a", "b", "a")))
    }

    @Test
    fun `the same code twice in one frame is one code`() {
        assertEquals(FrameSelection.Single("a"), FrameSelector.select(listOf("a", "a")))
    }

    @Test
    fun `one code is booked and blank or missing values are ignored`() {
        assertEquals(FrameSelection.Single("a"), FrameSelector.select(listOf("a")))
        assertEquals(FrameSelection.Single("a"), FrameSelector.select(listOf(null, "a", " ")))
        assertEquals(FrameSelection.None, FrameSelector.select(emptyList()))
        assertEquals(FrameSelection.None, FrameSelector.select(listOf(null, "")))
    }
}
