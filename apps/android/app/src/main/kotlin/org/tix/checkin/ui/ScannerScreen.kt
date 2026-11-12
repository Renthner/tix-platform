package org.tix.checkin.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.res.painterResource
import org.tix.checkin.core.scan.ResultStyle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import kotlinx.coroutines.delay
import org.tix.checkin.R
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanColor
import org.tix.checkin.core.scan.DecidedBy
import org.tix.checkin.core.scan.ScanVerdict
import org.tix.checkin.core.scan.seatText
import org.tix.checkin.sync.Connection

/** Neutral information screen (ticket not synced yet ...): not an alarm colour. */
private val InfoBg = Color(0xFF475569)
private val GreenBg = Color(0xFF1B8E3E)
private val YellowBg = Color(0xFFF2B600)
internal val RedBg = Color(0xFFC62828)

fun resultBackground(c: ScanColor): Color = when (c) {
    ScanColor.GREEN -> GreenBg
    ScanColor.YELLOW -> YellowBg
    ScanColor.RED -> RedBg
}

fun resultForeground(c: ScanColor): Color = if (c == ScanColor.YELLOW) Color(0xFF1A1400) else Color.White

@Composable
fun ScannerScreen(vm: MainViewModel, onChooseEvent: () -> Unit) {
    val event by vm.selectedEvent.collectAsState()
    val mode by vm.mode.collectAsState()
    val connection by vm.connection.collectAsState()
    val pending by vm.pendingCount.collectAsState()
    val valid by vm.validCount.collectAsState()
    val checkedIn by vm.checkedInCount.collectAsState()
    val status by vm.syncStatus.collectAsState()
    val lan by vm.lanState.collectAsState()
    val context = LocalContext.current

    // Keep the screen on while scanning.
    val view = LocalView.current
    DisposableEffect(view) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }

    val row = event
    if (row == null) {
        Column(
            Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(R.string.scanner_no_event), style = MaterialTheme.typography.titleMedium)
            Button(onClick = onChooseEvent, modifier = Modifier.heightIn(min = 56.dp)) {
                Text(stringResource(R.string.scanner_choose_event))
            }
        }
        return
    }

    val wide = isWideOrLandscape()
    val statusPanel: @Composable (Modifier) -> Unit = { panelModifier ->
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = panelModifier) {
            Column(
                Modifier.fillMaxWidth().then(if (wide) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(row.event.title, style = MaterialTheme.typography.titleMedium, maxLines = if (wide) 3 else 1, modifier = Modifier.weight(1f))
                    Text(
                        stringResource(
                            when (connection) {
                                Connection.ONLINE -> R.string.status_online
                                Connection.OFFLINE -> R.string.status_offline
                                Connection.MAINTENANCE -> R.string.status_maintenance
                            },
                        ),
                        fontWeight = FontWeight.Bold,
                        color = if (connection == Connection.ONLINE) GreenBg else RedBg,
                    )
                }
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.status_counts, checkedIn, valid), style = MaterialTheme.typography.bodyMedium)
                    Text(stringResource(R.string.status_pending, pending), style = MaterialTheme.typography.bodyMedium)
                }
                Text(
                    if (status.lastSuccessAt > 0) {
                        stringResource(R.string.status_last_sync, formatMillis(context, status.lastSuccessAt))
                    } else {
                        stringResource(R.string.status_never_synced)
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
                LanStatusLine(lan)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = mode == ScanAction.CHECK_IN,
                        onClick = { vm.setMode(ScanAction.CHECK_IN) },
                        label = { Text(stringResource(R.string.mode_check_in), modifier = Modifier.padding(vertical = 8.dp)) },
                    )
                    if (row.event.allowCheckOut) {
                        FilterChip(
                            selected = mode == ScanAction.CHECK_OUT,
                            onClick = { vm.setMode(ScanAction.CHECK_OUT) },
                            label = { Text(stringResource(R.string.mode_check_out), modifier = Modifier.padding(vertical = 8.dp)) },
                        )
                    }
                }
            }
        }
    }
    // Switching layouts recreates the QrScanner; its DisposableEffect unbinds and rebinds the camera to the lifecycle.
    if (wide) {
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxHeight()) {
                QrScanner(onCode = vm::onCode, modifier = Modifier.fillMaxSize(), debounceMillis = 2_500)
            }
            statusPanel(Modifier.width(340.dp).fillMaxHeight())
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            statusPanel(Modifier)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                QrScanner(onCode = vm::onCode, modifier = Modifier.fillMaxSize(), debounceMillis = 2_500)
            }
        }
    }
}

/** Full-screen result over everything: colour, big icon, headline, ticket data, warnings. */
@Composable
fun ResultOverlay(vm: MainViewModel, ui: VerdictUi) {
    val v = ui.verdict
    val greenSeconds by vm.settings.greenSeconds.collectAsState()
    val alertSeconds by vm.settings.alertSeconds.collectAsState()
    LaunchedEffect(ui.seq, greenSeconds, alertSeconds) {
        delay((if (v.color == ScanColor.GREEN) greenSeconds else alertSeconds) * 1000L)
        vm.dismissVerdict(ui.seq)
    }
    val palette by vm.resultPalette.collectAsState()
    // Information (not an alarm): neutral slate, no result colour. Otherwise the server's colours decide.
    val info = v.notice?.isInfo == true
    val style = if (info) ResultStyle(InfoBg.toArgb(), false, null, emptyList()) else palette.style(v.result, v.warnings)
    val bg = Color(style.background)
    val fg = if (style.darkContent) Color.Black else Color.White
    // Bars stay visible (edge to edge); their icons follow the text colour (dark on light backgrounds)
    // and are restored when the result is dismissed.
    val view = LocalView.current
    DisposableEffect(view, style.darkContent) {
        val window = (view.context as? android.app.Activity)?.window
        if (window == null) {
            onDispose { }
        } else {
            val controller = WindowCompat.getInsetsController(window, view)
            val prevStatus = controller.isAppearanceLightStatusBars
            val prevNav = controller.isAppearanceLightNavigationBars
            controller.isAppearanceLightStatusBars = style.darkContent
            controller.isAppearanceLightNavigationBars = style.darkContent
            onDispose {
                controller.isAppearanceLightStatusBars = prevStatus
                controller.isAppearanceLightNavigationBars = prevNav
            }
        }
    }
    val context = LocalContext.current
    val headline = stringResource(verdictHeadline(v))
    val tapDismiss = stringResource(R.string.result_tap_dismiss)
    val announcement = remember(v, style, headline, tapDismiss) {
        resultAnnouncement(context, v, style, headline, tapDismiss)
    }
    // Reading the result aloud (opt-in setting) is done by MainViewModel.show with text-to-speech.
    val fontScale = LocalDensity.current.fontScale
    Box(
        Modifier.fillMaxSize().background(bg).clickable { vm.dismissVerdict(ui.seq) },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            // One node with the whole verdict, so exploring by touch reads it in one piece instead of the parts.
            Modifier.widthIn(max = 600.dp).fillMaxWidth().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp)
                .clearAndSetSemantics { contentDescription = announcement },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val lead = style.lead
            if (lead != null) {
                Icon(painterResource(warningIcon(lead)), contentDescription = null, tint = fg, modifier = Modifier.size(120.dp))
            } else {
                Text(
                    when {
                        info -> "i"
                        v.result?.isAccepted == true -> "✓"
                        else -> "✕"
                    },
                    fontSize = (120f / fontScale).sp, fontWeight = FontWeight.Bold, color = fg,
                )
            }
            Text(
                headline,
                // Scales with the font setting, but only up to 1.3x so the headline stays on screen.
                fontSize = (34f * fontScale.coerceAtMost(1.3f) / fontScale).sp, fontWeight = FontWeight.Bold, color = fg, textAlign = TextAlign.Center,
            )
            ResultDetails(v, style, fg)
            Text(stringResource(R.string.result_tap_dismiss), color = fg.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Spoken form of the full-screen result: headline, ticket data, warnings, first scan. */
internal fun resultAnnouncement(context: android.content.Context, v: ScanVerdict, style: ResultStyle, headline: String, tapDismiss: String?): String {
    val parts = mutableListOf(headline)
    v.ticket?.let { t ->
        t.attendeeName?.takeIf { it.isNotBlank() }?.let { parts += it }
        val category = listOf(t.categoryName, t.ticketTypeName).filter { it.isNotBlank() }.joinToString(" - ")
        if (category.isNotEmpty()) parts += category
        val seat = seatText(t.sectionLabel, t.rowLabel, t.seatLabel)
        if (seat.isNotEmpty()) parts += seat
    }
    style.lead?.let { parts += warningText(context, v, it) }
    style.others.forEach { parts += warningText(context, v, it.warning) }
    if (v.result == org.tix.checkin.core.contract.ScanResult.REJECTED_ALREADY_CHECKED_IN) {
        v.firstScan?.let { parts += context.getString(R.string.result_first_scan, formatTime(context, it.at), it.deviceName ?: "-") }
    }
    tapDismiss?.let { parts += it }
    return parts.joinToString(". ")
}

@Composable
private fun ResultDetails(v: ScanVerdict, style: ResultStyle, fg: Color) {
    val context = LocalContext.current
    val t = v.ticket
    if (t != null) {
        val big = MaterialTheme.typography.headlineSmall
        t.attendeeName?.takeIf { it.isNotBlank() }?.let { Text(it, style = big, color = fg, textAlign = TextAlign.Center) }
        val category = listOf(t.categoryName, t.ticketTypeName).filter { it.isNotBlank() }.joinToString(" - ")
        if (category.isNotEmpty()) Text(category, style = big, color = fg, textAlign = TextAlign.Center)
        val seat = seatText(t.sectionLabel, t.rowLabel, t.seatLabel)
        if (seat.isNotEmpty()) Text(seat, style = big, fontWeight = FontWeight.Bold, color = fg, textAlign = TextAlign.Center)
    }
    // The leading warning decided the screen colour: plain text. Every other warning is a chip in its own colour.
    style.lead?.let { w ->
        Text(warningText(context, v, w), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = fg, textAlign = TextAlign.Center)
    }
    for (chip in style.others) {
        val chipFg = if (chip.darkContent) Color.Black else Color.White
        // The outline in the screen's text colour keeps a chip visible when its colour is close to the background.
        Surface(
            color = Color(chip.color), contentColor = chipFg, shape = RoundedCornerShape(50),
            border = BorderStroke(2.dp, fg),
        ) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(painterResource(warningIcon(chip.warning)), contentDescription = null, tint = chipFg, modifier = Modifier.size(28.dp))
                Text(warningText(context, v, chip.warning), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = chipFg)
            }
        }
    }
    if (v.result == org.tix.checkin.core.contract.ScanResult.REJECTED_ALREADY_CHECKED_IN) {
        v.firstScan?.let {
            Text(
                stringResource(R.string.result_first_scan, formatTime(context, it.at), it.deviceName ?: "-"),
                style = MaterialTheme.typography.titleMedium, color = fg, textAlign = TextAlign.Center,
            )
        }
    }
    if (v.provisional) {
        Text(stringResource(R.string.result_provisional), style = MaterialTheme.typography.bodyLarge, color = fg, textAlign = TextAlign.Center)
    }
    if (v.decidedBy != DecidedBy.SERVER && v.notice == null) {
        Text(stringResource(if (v.decidedBy == DecidedBy.LAN) R.string.result_lan_decision else R.string.result_offline_decision), style = MaterialTheme.typography.bodyMedium, color = fg.copy(alpha = 0.85f))
    }
    if (v.notice == org.tix.checkin.core.scan.VerdictNotice.OFFLINE_NOT_ALLOWED) {
        Text(stringResource(R.string.verdict_offline_not_allowed_hint), style = MaterialTheme.typography.bodyLarge, color = fg, textAlign = TextAlign.Center)
    }
}

/** LAN state in the status bar: nothing while LAN is not available for this device. */
@Composable
fun LanStatusLine(lan: org.tix.checkin.lan.LanUi) {
    if (!lan.available) return
    // Two masters for one event split the venue: shown prominently on every device that notices it.
    if (lan.duplicateMaster) {
        Text(
            stringResource(R.string.lan_duplicate_master),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = RedBg,
        )
    }
    val (text, color) = when {
        lan.role == org.tix.checkin.lan.LanRole.MASTER ->
            stringResource(R.string.lan_status_master, lan.clients) to GreenBg
        lan.serverError -> stringResource(R.string.lan_error_port) to RedBg
        lan.health == org.tix.checkin.core.lan.LanHealth.KEY_OUTDATED -> stringResource(R.string.lan_status_key_outdated) to RedBg
        lan.health == org.tix.checkin.core.lan.LanHealth.CLOCK_SKEW -> stringResource(R.string.lan_status_clock_skew) to RedBg
        lan.health == org.tix.checkin.core.lan.LanHealth.CONNECTED ->
            stringResource(R.string.lan_status_connected, lan.masterName.orEmpty()) to GreenBg
        lan.role == org.tix.checkin.lan.LanRole.CLIENT -> stringResource(R.string.lan_status_no_master) to Color(0xFF5F6368)
        else -> return
    }
    Text(text, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold, color = color)
}
