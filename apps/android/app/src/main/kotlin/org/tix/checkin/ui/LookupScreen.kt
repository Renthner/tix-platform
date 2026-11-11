package org.tix.checkin.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.tix.checkin.R
import org.tix.checkin.core.TicketCode
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.TicketStatus

@Composable
fun LookupScreen(vm: MainViewModel, onChooseEvent: () -> Unit) {
    val event by vm.selectedEvent.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }
    var result by remember { mutableStateOf<LookupResult?>(null) }
    var selected by remember { mutableStateOf<TicketRow?>(null) }
    val row = event
    if (row == null) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.scanner_no_event), style = MaterialTheme.typography.titleMedium)
            Button(onClick = onChooseEvent, modifier = Modifier.heightIn(min = 56.dp)) { Text(stringResource(R.string.scanner_choose_event)) }
        }
        return
    }

    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(query, row.event.id, refresh) {
        delay(300) // debounce typing
        result = if (query.trim().length >= 2) vm.search(row.event.id, query) else null
    }

    val detail = selected
    if (detail != null) {
        TicketDetail(vm, row, detail, onBack = { selected = null }, onChanged = { refresh++ })
        return
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.lookup_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 16.dp))
        OutlinedTextField(
            value = query, onValueChange = { query = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.lookup_hint)) },
        )
        val r = result
        if (r != null) {
            Text(
                stringResource(if (r.fromServer) R.string.lookup_source_server else R.string.lookup_source_local),
                style = MaterialTheme.typography.bodySmall,
            )
            if (r.rows.isEmpty()) Text(stringResource(if (r.fromServer) R.string.lookup_empty else R.string.lookup_empty_offline))
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(r.rows, key = { it.id }) { t ->
                    Card(Modifier.fillMaxWidth().clickable { selected = t }) {
                        Column(Modifier.padding(12.dp)) {
                            Text(t.attendeeName ?: t.buyerName ?: "-", style = MaterialTheme.typography.titleMedium)
                            Text(listOf(t.categoryName, t.seatLabel).filter { it.isNotBlank() }.joinToString(" - "))
                            Text(stateLabel(t), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        } else {
            Text(stringResource(R.string.lookup_min_chars), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun stateLabel(t: TicketRow): String = stringResource(
    when {
        t.status != TicketStatus.VALID -> R.string.ticket_state_void
        t.checkInState == CheckInState.CHECKED_IN -> R.string.ticket_state_in
        t.checkInState == CheckInState.CHECKED_OUT -> R.string.ticket_state_out
        else -> R.string.ticket_state_none
    },
)

@Composable
private fun TicketDetail(vm: MainViewModel, event: EventRow, t: TicketRow, onBack: () -> Unit, onChanged: () -> Unit) {
    val context = LocalContext.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (t.status != TicketStatus.VALID) {
            val reason = stringResource(
                when (t.status) {
                    TicketStatus.CANCELLED -> R.string.void_reason_cancelled
                    TicketStatus.REFUNDED -> R.string.void_reason_refunded
                    TicketStatus.REPLACED -> R.string.void_reason_replaced
                    else -> R.string.void_reason_unknown
                },
            )
            Surface(color = RedBg, contentColor = Color.White, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                Text(
                    stringResource(R.string.lookup_void_banner, reason),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
        Text(t.attendeeName ?: t.buyerName ?: "-", style = MaterialTheme.typography.headlineSmall)
        if (t.categoryName.isNotBlank()) Text(t.categoryName, style = MaterialTheme.typography.titleMedium)
        if (t.seatLabel.isNotBlank()) Text(t.seatLabel, style = MaterialTheme.typography.titleMedium)
        if (t.ticketCode.isNotBlank()) Text(stringResource(R.string.lookup_code, TicketCode.format(t.ticketCode)))
        val order = t.orderNumber?.takeIf { it.isNotBlank() }
        Text(if (order != null) stringResource(R.string.lookup_order, order) else stringResource(R.string.lookup_order_unavailable))
        t.seatFeature?.let { Text(stringResource(seatFeatureLabel(it))) }
        Text(stateLabel(t), style = MaterialTheme.typography.titleSmall)
        t.firstCheckedInAt?.let { Text(stringResource(R.string.lookup_first_in, formatTime(context, it))) }
        Button(
            onClick = { vm.manualScan(t.id, event.event.id, ScanAction.CHECK_IN, onChanged); onBack() },
            enabled = t.status == TicketStatus.VALID,
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
        ) { Text(stringResource(R.string.mode_check_in)) }
        if (event.event.allowCheckOut) {
            OutlinedButton(
                onClick = { vm.manualScan(t.id, event.event.id, ScanAction.CHECK_OUT, onChanged); onBack() },
                enabled = t.status == TicketStatus.VALID,
                modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
            ) { Text(stringResource(R.string.mode_check_out)) }
        }
        Row { OutlinedButton(onClick = onBack, modifier = Modifier.heightIn(min = 52.dp)) { Text(stringResource(R.string.action_back)) } }
    }
}
