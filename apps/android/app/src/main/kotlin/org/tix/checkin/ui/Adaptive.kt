package org.tix.checkin.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Width classes after the Material window size class breakpoints (600 / 840 dp). */
enum class WidthClass { COMPACT, MEDIUM, EXPANDED }

/**
 * Current window width class. Read from [LocalConfiguration], which Compose refreshes on rotation / resize
 * (the activity handles configChanges itself), so no dependency beyond Compose UI is needed.
 */
@Composable
fun currentWidthClass(): WidthClass {
    val w = LocalConfiguration.current.screenWidthDp
    return when {
        w >= 840 -> WidthClass.EXPANDED
        w >= 600 -> WidthClass.MEDIUM
        else -> WidthClass.COMPACT
    }
}

/** Wide window or landscape: the scanner puts viewfinder and status side by side. */
@Composable
fun isWideOrLandscape(): Boolean {
    val c = LocalConfiguration.current
    return c.screenWidthDp >= 840 || c.screenWidthDp > c.screenHeightDp
}

val ReadableMaxWidth: Dp = 720.dp

/** Keeps [content] at most [maxWidth] wide, centred horizontally and filling the height. */
@Composable
fun ReadableWidth(maxWidth: Dp = ReadableMaxWidth, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.fillMaxHeight().widthIn(max = maxWidth).fillMaxWidth()) { content() }
    }
}
