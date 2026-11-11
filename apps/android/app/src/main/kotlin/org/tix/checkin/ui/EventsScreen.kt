package org.tix.checkin.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.tix.checkin.R
import org.tix.checkin.sync.Connection

@Composable
fun EventsScreen(vm: MainViewModel, onSelected: () -> Unit) {
    val rows by vm.events.collectAsState()
    val selected by vm.selectedEvent.collectAsState()
    val status by vm.syncStatus.collectAsState()
    val connection by vm.connection.collectAsState()
    val context = LocalContext.current

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.events_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 16.dp))
        if (status.running) {
            Text(stringResource(R.string.events_syncing, status.progress ?: 0), style = MaterialTheme.typography.bodyMedium)
        } else if (connection != Connection.ONLINE || status.lastError != null) {
            Text(stringResource(R.string.events_sync_problem), color = MaterialTheme.colorScheme.error)
        }
        if (rows.isEmpty()) {
            Text(stringResource(R.string.events_empty))
            Button(onClick = vm::syncNow, modifier = Modifier.heightIn(min = 52.dp)) { Text(stringResource(R.string.events_sync_now)) }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(rows, key = { it.event.id }) { row ->
                val isSelected = selected?.event?.id == row.event.id
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { vm.selectEvent(row.event.id); onSelected() },
                    colors = CardDefaults.cardColors(
                        containerColor = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(row.event.title, style = MaterialTheme.typography.titleMedium)
                        Text(formatTime(context, row.event.startsAt) + " - " + row.event.venueName, style = MaterialTheme.typography.bodyMedium)
                        // Entrance of this device for the event (name from the manifest).
                        Text(
                            stringResource(R.string.events_entrance, entranceName(vm, row) ?: stringResource(R.string.events_entrance_any)),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(stringResource(R.string.events_offline_ready, row.validTickets), style = MaterialTheme.typography.bodyMedium)
                        Text(
                            row.lastSyncAt?.let { stringResource(R.string.events_last_sync, formatMillis(context, it)) }
                                ?: stringResource(R.string.status_never_synced),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        if (row.event.allowCheckOut) Text(stringResource(R.string.events_check_out_allowed), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun entranceName(vm: MainViewModel, row: EventRow): String? {
    val id = row.event.entranceId ?: return null
    val names by vm.entranceNames.collectAsState()
    return names[row.event.id to id]
}
