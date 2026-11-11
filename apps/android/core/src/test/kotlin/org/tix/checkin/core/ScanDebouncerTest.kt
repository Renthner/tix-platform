package org.tix.checkin.core

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ScanDebouncerTest {
    @Test
    fun `suppresses repeats inside the window and slides it`() {
        var now = 0L
        val d = ScanDebouncer(windowMillis = 1_000, clock = { now })
        assertTrue(d.accept("a"))
        now = 500
        assertFalse(d.accept("a"))
        now = 1_400 // 900 ms after the last sighting: still the same continuous scan
        assertFalse(d.accept("a"))
        now = 2_500
        assertTrue(d.accept("a"))
    }

    @Test
    fun `different codes do not interfere`() {
        var now = 0L
        val d = ScanDebouncer(windowMillis = 1_000, clock = { now })
        assertTrue(d.accept("a"))
        assertTrue(d.accept("b"))
        now = 100
        assertFalse(d.accept("a"))
        assertFalse(d.accept("b"))
        d.reset()
        assertTrue(d.accept("a"))
    }
}
