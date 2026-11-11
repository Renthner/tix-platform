package org.tix.checkin

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import org.tix.checkin.ui.TixApp
import org.tix.checkin.ui.TixTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Transparent bars; icon colour follows the system dark/light setting (same source as TixTheme).
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        // Foreground sync loop: runs only while the app is visible (background work: WorkManager).
        val container = (application as TixApplication).container
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { container.sync.runLoop() }
                // LAN: client loop (discovery + pull/push) and, in master mode, the foreground service. The
                // service may only be started while the app is visible, hence here.
                launch { container.lan.runClientLoop() }
                launch {
                    while (true) {
                        container.lan.ensureMasterRunning(this@MainActivity)
                        kotlinx.coroutines.delay(5_000)
                    }
                }
            }
        }
        setContent {
            TixTheme { TixApp() }
        }
    }
}
