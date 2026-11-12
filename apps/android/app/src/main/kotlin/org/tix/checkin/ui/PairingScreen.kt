package org.tix.checkin.ui

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.text.font.FontWeight
import org.tix.checkin.core.ServerUrlPolicy
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import org.tix.checkin.R
import org.tix.checkin.core.Pairing
import org.tix.checkin.sync.PairingNotice

@Composable
fun PairingScreen(vm: MainViewModel) {
    val state by vm.pair.collectAsState()
    val status by vm.syncStatus.collectAsState()
    val notice by vm.settings.pairingNotice.collectAsState()
    var url by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    var name by rememberSaveable { mutableStateOf(defaultDeviceName(context)) }
    // Manual entry first; the camera only opens when the operator taps "Scan QR code".
    var manual by rememberSaveable { mutableStateOf(true) }
    val busy = state is PairUi.Working || state is PairUi.Syncing

    // A scanned QR code only fills this in: the operator sees WHICH server it points to and confirms first.
    var scanned by remember { mutableStateOf<Pairing.Target?>(null) }

    fun onScanned(raw: String) {
        val target = Pairing.parseUri(raw) ?: return
        url = target.serverUrl
        code = target.code
        scanned = target
    }

    Column(
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(stringResource(R.string.pairing_title), style = MaterialTheme.typography.headlineSmall)
        if (notice == PairingNotice.REVOKED) {
            Text(stringResource(R.string.pairing_revoked), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
        }
        Text(stringResource(R.string.pairing_hint))
        OutlinedTextField(
            value = name, onValueChange = { name = it }, singleLine = true, enabled = !busy,
            label = { Text(stringResource(R.string.pairing_device_name)) }, modifier = Modifier.fillMaxWidth(),
        )
        val target = scanned
        if (target != null && !busy) {
            val allowed = ServerUrlPolicy.isAllowed(target.serverUrl)
            Text(stringResource(R.string.pairing_confirm_title), style = MaterialTheme.typography.titleMedium)
            Text(target.serverUrl, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(stringResource(R.string.pairing_confirm_hint))
            if (!allowed) Text(stringResource(R.string.pairing_error_url), color = MaterialTheme.colorScheme.error)
            Button(
                onClick = { scanned = null; vm.pair(target.serverUrl, target.code, name) },
                enabled = allowed && name.isNotBlank(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text(stringResource(R.string.pairing_confirm_button)) }
            OutlinedButton(onClick = { scanned = null }, modifier = Modifier.heightIn(min = 52.dp)) {
                Text(stringResource(R.string.action_cancel))
            }
        } else if (!manual) {
            Column(Modifier.fillMaxWidth().heightIn(min = 260.dp, max = 380.dp)) {
                if (!busy) QrScanner(onCode = ::onScanned, modifier = Modifier.fillMaxSize())
            }
            OutlinedButton(onClick = { manual = true }, modifier = Modifier.heightIn(min = 52.dp)) {
                Text(stringResource(R.string.pairing_enter_manually))
            }
        } else {
            OutlinedTextField(
                value = url, onValueChange = { url = it; vm.resetPairError() }, singleLine = true, enabled = !busy,
                label = { Text(stringResource(R.string.pairing_server_url)) },
                placeholder = { Text("http://192.168.1.20:8080") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = code, onValueChange = { code = it; vm.resetPairError() }, singleLine = true, enabled = !busy,
                label = { Text(stringResource(R.string.pairing_code)) },
                placeholder = { Text("ABCDE-FGHJK") },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = { vm.pair(url, code, name) },
                enabled = !busy && url.isNotBlank() && Pairing.normalizeCode(code).length == Pairing.CODE_LENGTH && name.isNotBlank(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text(stringResource(R.string.pairing_button)) }
            OutlinedButton(onClick = { manual = false }, modifier = Modifier.heightIn(min = 52.dp)) {
                Text(stringResource(R.string.pairing_scan_qr))
            }
        }
        when (val s = state) {
            PairUi.Working -> { CircularProgressIndicator(); Text(stringResource(R.string.pairing_working)) }
            PairUi.Syncing -> {
                CircularProgressIndicator()
                Text(stringResource(R.string.pairing_syncing, status.progress ?: 0))
            }
            is PairUi.Failed -> Text(
                stringResource(s.message) + (s.detail?.let { " ($it)" } ?: ""),
                color = MaterialTheme.colorScheme.error,
            )
            PairUi.Idle -> Unit
        }
    }
}

/** The name the user gave the phone (Settings → About phone → Device name), else the model. */
private fun defaultDeviceName(context: Context): String {
    val resolver = context.contentResolver
    // Some OEM builds (e.g. older One UI) keep the user-set name only in Settings.System.
    val userName = sequenceOf(
        { Settings.Global.getString(resolver, Settings.Global.DEVICE_NAME) },
        { Settings.System.getString(resolver, "device_name") },
    ).firstNotNullOfOrNull { read -> runCatching(read).getOrNull()?.trim()?.takeIf { it.isNotEmpty() } }
    return (userName ?: Build.MODEL.orEmpty()).take(40)
}
