package org.tix.checkin.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.tix.checkin.R
import org.tix.checkin.sync.PairingNotice
import org.tix.checkin.sync.UnpairBlock

/**
 * Blocks the whole app when the device is being unpaired (server revoked it, or the operator asked) while scans were
 * never uploaded. The token is gone, so they can never be uploaded: the operator can export them as a JSON file
 * (share sheet) before everything is wiped. Nothing is deleted until "discard and unpair" is confirmed.
 */
@Composable
fun UnpairBlockedScreen(vm: MainViewModel, block: UnpairBlock) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf(false) }
    var exportFailed by remember { mutableStateOf(false) }
    val chooserTitle = stringResource(R.string.unpair_blocked_export)

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.unpair_blocked_title), style = MaterialTheme.typography.headlineSmall)
            if (block.notice == PairingNotice.REVOKED) {
                Text(stringResource(R.string.pairing_revoked), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
            }
            Text(stringResource(R.string.unpair_blocked_count, block.unsentScans), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(if (block.notice == PairingNotice.REVOKED) R.string.unpair_blocked_hint else R.string.unpair_blocked_hint_operator))
            Button(
                onClick = {
                    scope.launch {
                        val intent = vm.exportUnsentIntent()
                        if (intent == null) {
                            exportFailed = true
                        } else {
                            exportFailed = false
                            context.startActivity(Intent.createChooser(intent, chooserTitle))
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text(stringResource(R.string.unpair_blocked_export)) }
            if (block.notice != PairingNotice.REVOKED) {
                OutlinedButton(onClick = vm::cancelUnpair, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Text(stringResource(R.string.unpair_blocked_cancel))
                }
            }
            if (exportFailed) Text(stringResource(R.string.unpair_blocked_export_failed), color = MaterialTheme.colorScheme.error)
            OutlinedButton(
                onClick = { confirm = true },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text(stringResource(R.string.unpair_blocked_discard)) }
        }
    }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.unpair_blocked_discard)) },
            text = { Text(stringResource(R.string.unpair_blocked_discard_confirm, block.unsentScans)) },
            confirmButton = {
                TextButton(onClick = { confirm = false; vm.discardAndUnpair() }) { Text(stringResource(R.string.unpair_blocked_discard)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}
