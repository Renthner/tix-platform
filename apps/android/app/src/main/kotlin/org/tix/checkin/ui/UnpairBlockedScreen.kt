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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.tix.checkin.R
import org.tix.checkin.sync.PairingNotice
import org.tix.checkin.sync.UnpairBlock

private const val RETRY_SECONDS = 15

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

    // Operator-initiated unpair: the token is still valid, so the upload is retried every RETRY_SECONDS (and at once
    // when the network comes back); when nothing is left the unpair continues by itself. After a revocation the
    // token is dead: nothing to retry, export is the only way out.
    val revoked = block.notice == PairingNotice.REVOKED
    val retry by vm.unpairRetry.collectAsState()
    var secondsLeft by remember { mutableIntStateOf(RETRY_SECONDS) }
    var wakeTick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { vm.networkWake.collect { wakeTick++ } }
    LaunchedEffect(revoked, retry.refused, wakeTick) {
        if (revoked || retry.refused) return@LaunchedEffect
        var immediate = wakeTick > 0
        while (true) {
            if (!immediate) {
                for (s in RETRY_SECONDS downTo 1) {
                    secondsLeft = s
                    delay(1_000)
                }
            }
            immediate = false
            secondsLeft = 0
            vm.retryUnpairUpload()
            delay(500) // let the attempt start before waiting for it to finish
            while (vm.unpairRetry.value.running) delay(300)
        }
    }

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
            Text(stringResource(if (revoked) R.string.unpair_blocked_hint else R.string.unpair_blocked_hint_operator))
            if (revoked) {
                Text(stringResource(R.string.unpair_blocked_no_retry), style = MaterialTheme.typography.bodyMedium)
            } else {
                Text(
                    stringResource(
                        when {
                            retry.running -> R.string.unpair_blocked_retrying
                            retry.refused -> R.string.unpair_blocked_refused
                            else -> R.string.unpair_blocked_retry_in
                        },
                        secondsLeft,
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                )
                retry.lastError?.let {
                    Text(stringResource(R.string.unpair_blocked_last_error, it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
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
