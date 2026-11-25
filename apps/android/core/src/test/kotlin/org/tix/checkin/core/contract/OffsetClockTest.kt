package org.tix.checkin.core.contract

import kotlin.test.Test
import kotlin.test.assertEquals

class OffsetClockTest {
    private var wall = 1_000_000L
    private var mono = 5_000L

    private fun clock(offset: Long? = null) = OffsetClock(offset, wall = { wall }, mono = { mono })

    @Test
    fun `follows the wall clock until the server time is known`() {
        val c = clock()
        assertEquals(1_000_000L, c.nowMillis())
        wall += 700
        assertEquals(1_000_700L, c.nowMillis())
    }

    @Test
    fun `learned server time advances with the monotonic clock only`() {
        val c = clock()
        c.learn(Iso.format(2_000_000L))
        assertEquals(2_000_000L, c.nowMillis())
        mono += 1_500
        wall += 1_500
        assertEquals(2_001_500L, c.nowMillis())
        // the operator (or NTP) jumps the wall clock by an hour: scan times do not move
        wall += 3_600_000
        assertEquals(2_001_500L, c.nowMillis())
        mono += 500
        assertEquals(2_002_000L, c.nowMillis())
    }

    @Test
    fun `offset is derived from the anchor and restoring it anchors at once`() {
        val c = clock()
        c.learn(Iso.format(wall + 40_000))
        assertEquals(40_000L, c.offsetMillis)
        val restored = clock()
        restored.offsetMillis = 40_000
        assertEquals(wall + 40_000, restored.nowMillis())
        wall += 9_999_999 // wall clock changed after the restore
        assertEquals(1_040_000L, restored.nowMillis())
        assertEquals(clock(40_000).nowMillis(), wall + 40_000)
    }

    @Test
    fun `unparsable server time keeps the current clock`() {
        val c = clock()
        c.learn("garbage")
        c.learn(null)
        assertEquals(wall, c.nowMillis())
    }
}
