package org.tix.checkin.lan

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MasterLocksTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `acquire holds wifi and cpu lock, release frees both, both are idempotent`() {
        val locks = MasterLocks(context)
        assertFalse(locks.isHeld)
        locks.acquire()
        locks.acquire() // service restart (START_STICKY): must not stack
        assertTrue(locks.isHeld)
        val wake = org.robolectric.shadows.ShadowPowerManager.getLatestWakeLock()
        assertTrue(wake.isHeld)
        locks.release()
        assertFalse(locks.isHeld)
        assertFalse(wake.isHeld)
        locks.release() // onDestroy after a failed start
        assertFalse(locks.isHeld)
    }

    @Test
    fun `locks can be taken again after a release (master switched off and on)`() {
        val locks = MasterLocks(context)
        locks.acquire()
        locks.release()
        locks.acquire()
        assertTrue(locks.isHeld)
        locks.release()
        assertFalse(locks.isHeld)
    }

    @Test
    fun `wifi lock modes per API level - high performance is held below 34, low latency from 29`() {
        @Suppress("DEPRECATION")
        val high = android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
        val low = android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        assertEquals(listOf(high), MasterLocks.wifiModes(28))
        assertEquals(listOf(low, high), MasterLocks.wifiModes(29))
        assertEquals(listOf(low, high), MasterLocks.wifiModes(33))
        assertEquals(listOf(low), MasterLocks.wifiModes(34))
    }

    @Test
    fun `acquire on a held lock renews instead of failing`() {
        val locks = MasterLocks(context)
        locks.acquire()
        locks.acquire() // hourly renewal from the service
        assertTrue(locks.isHeld)
        locks.release()
        assertFalse(locks.isHeld)
    }

    @Test
    fun `release without acquire is a no-op`() {
        val locks = MasterLocks(context)
        locks.release()
        assertFalse(locks.isHeld)
    }
}
