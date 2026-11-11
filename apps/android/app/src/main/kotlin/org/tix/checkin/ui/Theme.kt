package org.tix.checkin.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF1F2A44),
    onPrimary = Color.White,
    secondary = Color(0xFF3D5A80),
    background = Color(0xFFFAFAFC),
    surface = Color(0xFFFAFAFC),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFB8C7E8),
    onPrimary = Color(0xFF0F1830),
    secondary = Color(0xFF9DB4D8),
    background = Color(0xFF101319),
    surface = Color(0xFF101319),
)

@Composable
fun TixTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors) {
        // Root surface: every screen gets the themed background and a matching content colour
        // (without it the window shows its own background and text/bars can be unreadable).
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background, content = content)
    }
}
