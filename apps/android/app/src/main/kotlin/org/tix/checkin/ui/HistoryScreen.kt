package org.tix.checkin.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.tix.checkin.R
import org.tix.checkin.core.contract.ScanColor
import org.tix.checkin.core.scan.DecidedBy
import org.tix.checkin.core.scan.JournalEntry

private enum class HistoryFilter { ALL, GREEN, YELLOW, RED, PENDING }

@Composable
fun HistoryScreen(vm: MainViewModel) {
    val all by vm.journal.collectAsState()
    val quarantined by vm.quarantinedCount.collectAsState()
    var filter by rememberSaveable { mutableStateOf(HistoryFilter.ALL) }
    val context = LocalContext.current
    val shown = all.filter {
        when (filter) {
            HistoryFilter.ALL -> true
            HistoryFilter.GREEN -> it.result.color == ScanColor.GREEN
            HistoryFilter.YELLOW -> it.result.color == ScanColor.YELLOW
            HistoryFilter.RED -> it.result.color == ScanColor.RED
            HistoryFilter.PENDING -> !it.uploaded
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.history_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (f in HistoryFilter.entries) {
                FilterChip(
                    selected = filter == f, onClick = { filter = f },
                    label = {
                        Text(
                            stringResource(
                                when (f) {
                                    HistoryFilter.ALL -> R.string.history_all
                                    HistoryFilter.GREEN -> R.string.history_green
                                    HistoryFilter.YELLOW -> R.string.history_yellow
                                    HistoryFilter.RED -> R.string.history_red
                                    HistoryFilter.PENDING -> R.string.history_pending
                                },
                            ),
                        )
                    },
                )
            }
        }
        if (quarantined > 0) {
            // Refused by the server as requests: not uploaded, retried after an app update.
            Text(
                stringResource(R.string.history_quarantined_banner, quarantined),
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (shown.isEmpty()) Text(stringResource(R.string.history_empty))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(shown, key = { it.clientScanId }) { e ->
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = resultBackground(e.result.color).copy(alpha = 0.18f)),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            stringResource(resultHeadline(e.result, e.action)) + "  -  " + formatMillis(context, e.scannedAtMillis),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        val who = listOfNotNull(e.attendeeName, e.categoryName, e.seatLabel?.takeIf { it.isNotBlank() }).joinToString(" - ")
                        if (who.isNotEmpty()) Text(who)
                        Text(stringResource(uploadLabel(e)), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

private fun uploadLabel(e: JournalEntry): Int = when {
    e.uploadError != null -> R.string.history_upload_failed
    e.conflict -> R.string.history_conflict
    !e.uploaded -> R.string.history_not_uploaded
    e.decidedBy == DecidedBy.SERVER -> R.string.history_server
    e.decidedBy == DecidedBy.LAN -> R.string.history_lan
    else -> R.string.history_uploaded
}
