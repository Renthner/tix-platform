package org.tix.checkin.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.annotation.StringRes
import androidx.compose.material3.LinearProgressIndicator
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import org.tix.checkin.BuildConfig
import org.tix.checkin.R
import org.tix.checkin.core.contract.AppLatest
import org.tix.checkin.update.ApkInstaller

@Composable
fun SettingsScreen(vm: MainViewModel) {
    val context = LocalContext.current
    val cfg by vm.config.collectAsState()
    val green by vm.settings.greenSeconds.collectAsState()
    val alert by vm.settings.alertSeconds.collectAsState()
    val sound by vm.settings.sound.collectAsState()
    val vibrate by vm.settings.vibrate.collectAsState()
    val update by vm.update.collectAsState()
    val updateConfig by vm.settings.appUpdate.collectAsState()
    val channelOverride by vm.settings.channelOverride.collectAsState()
    androidx.compose.runtime.LaunchedEffect(Unit) { vm.checkUpdateOnOpen() }
    var confirmUnpair by remember { mutableStateOf(false) }
    var confirmResync by remember { mutableStateOf(false) }
    val lanMaster by vm.settings.lanMaster.collectAsState()

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.headlineSmall)

        cfg?.let { c ->
            Text(stringResource(R.string.settings_device, c.deviceName), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.settings_server, c.serverUrl))
            if (!c.offlineModeAllowed) Text(stringResource(R.string.settings_offline_not_allowed), color = MaterialTheme.colorScheme.error)
        }
        HorizontalDivider()

        Stepper(stringResource(R.string.settings_green_seconds), green, { vm.settings.setGreenSeconds(green - 1) }, { vm.settings.setGreenSeconds(green + 1) })
        Stepper(stringResource(R.string.settings_alert_seconds), alert, { vm.settings.setAlertSeconds(alert - 1) }, { vm.settings.setAlertSeconds(alert + 1) })
        SwitchRow(stringResource(R.string.settings_sound), sound, vm.settings::setSound)
        SwitchRow(stringResource(R.string.settings_vibrate), vibrate, vm.settings::setVibrate)
        HorizontalDivider()
        LanSection(vm)
        HorizontalDivider()

        Text(stringResource(R.string.settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE))
        if (updateConfig.source == org.tix.checkin.core.UpdateSource.GITHUB) {
            Text(stringResource(R.string.settings_update_source_github, vm.settings.effectiveRepository().ifEmpty { "-" }), style = MaterialTheme.typography.bodySmall)
            if (updateConfig.allowChannelOverride) {
                val channel = org.tix.checkin.core.UpdateChannel.effective(updateConfig.defaultChannel, true, channelOverride)
                Text(stringResource(R.string.settings_update_channel))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = channel == org.tix.checkin.core.UpdateChannel.STABLE,
                        onClick = { vm.setUpdateChannel(org.tix.checkin.core.UpdateChannel.STABLE) },
                        label = { Text(stringResource(R.string.settings_update_channel_stable)) },
                    )
                    FilterChip(
                        selected = channel == org.tix.checkin.core.UpdateChannel.NEXT,
                        onClick = { vm.setUpdateChannel(org.tix.checkin.core.UpdateChannel.NEXT) },
                        label = { Text(stringResource(R.string.settings_update_channel_next)) },
                    )
                }
            } else {
                val channel = if (updateConfig.defaultChannel == org.tix.checkin.core.UpdateChannel.NEXT) R.string.settings_update_channel_next else R.string.settings_update_channel_stable
                Text(stringResource(R.string.settings_update_channel_fixed, stringResource(channel)), style = MaterialTheme.typography.bodySmall)
            }
        } else {
            Text(stringResource(R.string.settings_update_source_server), style = MaterialTheme.typography.bodySmall)
        }
        OutlinedButton(onClick = { vm.checkUpdate() }, modifier = Modifier.heightIn(min = 52.dp)) { Text(stringResource(R.string.settings_check_update)) }
        when (val u = update) {
            UpdateUi.Checking -> Text(stringResource(R.string.settings_update_checking))
            UpdateUi.UpToDate -> Text(stringResource(R.string.settings_update_current))
            UpdateUi.NoRelease -> Text(stringResource(R.string.settings_update_none))
            UpdateUi.ServerUrlMissing -> Text(stringResource(R.string.settings_update_server_url_missing), color = MaterialTheme.colorScheme.error)
            UpdateUi.RepositoryMissing -> Text(stringResource(R.string.settings_update_repository_missing), color = MaterialTheme.colorScheme.error)
            is UpdateUi.RateLimited -> Text(
                stringResource(R.string.settings_update_rate_limited, formatMillis(context, u.untilMillis)),
                color = MaterialTheme.colorScheme.error,
            )
            UpdateUi.Failed -> Text(stringResource(R.string.settings_update_failed), color = MaterialTheme.colorScheme.error)
            is UpdateUi.Available -> {
                Text(stringResource(R.string.settings_update_available, u.info.versionName, u.info.versionCode), style = MaterialTheme.typography.titleSmall)
                u.info.notes?.takeIf { it.isNotBlank() }?.let { Text(it) }
                if (u.info.sha256.isNotBlank()) Text(stringResource(R.string.settings_update_sha, u.info.sha256), style = MaterialTheme.typography.bodySmall)
                // Only used when the link passes the server address policy (https, or http in the local network).
                val link = vm.downloadUrl(u.info)
                if (link == null) {
                    Text(stringResource(R.string.settings_update_url_refused), color = MaterialTheme.colorScheme.error)
                } else {
                    UpdateInstall(vm, u.info, onBrowser = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) })
                }
            }
            UpdateUi.Unknown -> Unit
        }
        HorizontalDivider()

        OutlinedButton(onClick = { confirmResync = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
            Text(stringResource(R.string.settings_force_resync))
        }
        Button(
            onClick = { confirmUnpair = true },
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
        ) { Text(stringResource(R.string.settings_unpair)) }
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text(stringResource(R.string.settings_unpair)) },
            text = { Text(stringResource(R.string.settings_unpair_confirm)) },
            confirmButton = { TextButton(onClick = { confirmUnpair = false; vm.unpair() }) { Text(stringResource(R.string.settings_unpair)) } },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    if (confirmResync) {
        AlertDialog(
            onDismissRequest = { confirmResync = false },
            title = { Text(stringResource(R.string.settings_force_resync)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.settings_force_resync_confirm))
                    // Master mode: the LAN state other doors rely on is kept, only what the server can resend is reloaded.
                    if (lanMaster) Text(stringResource(R.string.settings_force_resync_confirm_master), style = MaterialTheme.typography.bodyMedium)
                }
            },
            confirmButton = { TextButton(onClick = { confirmResync = false; vm.forceResync() }) { Text(stringResource(R.string.settings_force_resync)) } },
            dismissButton = { TextButton(onClick = { confirmResync = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

/** "Update now" with progress/cancel, the unsent-scan warning and the "Install unknown apps" guidance; the browser stays as a fallback. */
@Composable
private fun UpdateInstall(vm: MainViewModel, info: AppLatest, onBrowser: () -> Unit) {
    val context = LocalContext.current
    val state by vm.install.collectAsState()
    // Back from the system "Install unknown apps" page: continue when it is allowed now.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.onResumedFromSettings() }

    when (val s = state) {
        is InstallUi.Downloading -> {
            if (s.total > 0) {
                LinearProgressIndicator(progress = { (s.read.toFloat() / s.total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                Text(stringResource(R.string.update_downloading_mb, s.read / 1_048_576, s.total / 1_048_576), style = MaterialTheme.typography.bodySmall)
            } else {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            OutlinedButton(onClick = vm::cancelUpdate, modifier = Modifier.heightIn(min = 52.dp)) { Text(stringResource(R.string.action_cancel)) }
        }
        InstallUi.Syncing -> {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.update_syncing))
        }
        InstallUi.Installing -> {
            Text(stringResource(R.string.update_installing))
            OutlinedButton(onClick = vm::cancelUpdate, modifier = Modifier.heightIn(min = 52.dp)) { Text(stringResource(R.string.action_cancel)) }
        }
        else -> {
            Button(onClick = { vm.startUpdate(info) }, modifier = Modifier.heightIn(min = 52.dp)) { Text(stringResource(R.string.update_now)) }
            if (s is InstallUi.NeedInstallPermission) {
                Text(stringResource(R.string.update_permission_needed), color = MaterialTheme.colorScheme.error)
                OutlinedButton(
                    onClick = { context.startActivity(ApkInstaller.unknownSourcesIntent(context)) },
                    modifier = Modifier.heightIn(min = 52.dp),
                ) { Text(stringResource(R.string.update_permission_open)) }
            }
            if (s is InstallUi.Failed) {
                Text(stringResource(updateFailureText(s.reason)), color = MaterialTheme.colorScheme.error)
            }
        }
    }
    TextButton(onClick = onBrowser) { Text(stringResource(R.string.settings_update_download)) }

    (state as? InstallUi.UnsentScans)?.let { s ->
        AlertDialog(
            onDismissRequest = vm::cancelUpdate,
            title = { Text(stringResource(R.string.update_unsent_title)) },
            text = { Text(stringResource(R.string.update_unsent_text, s.count)) },
            confirmButton = { TextButton(onClick = vm::syncThenUpdate) { Text(stringResource(R.string.update_unsent_sync)) } },
            dismissButton = {
                Row {
                    TextButton(onClick = vm::installAnyway) { Text(stringResource(R.string.update_unsent_anyway)) }
                    TextButton(onClick = vm::cancelUpdate) { Text(stringResource(R.string.action_cancel)) }
                }
            },
        )
    }
}

@StringRes
private fun updateFailureText(reason: UpdateFailure): Int = when (reason) {
    UpdateFailure.HASH_MISSING -> R.string.update_error_hash_missing
    UpdateFailure.HASH_MISMATCH -> R.string.update_error_hash_mismatch
    UpdateFailure.NETWORK -> R.string.update_error_network
    UpdateFailure.HTTP -> R.string.update_error_http
    UpdateFailure.TOO_LARGE -> R.string.update_error_too_large
    UpdateFailure.STORAGE -> R.string.update_error_storage
    UpdateFailure.URL_REFUSED -> R.string.settings_update_url_refused
    UpdateFailure.NOT_A_VALID_UPDATE -> R.string.update_error_not_valid
    UpdateFailure.SIGNATURE -> R.string.update_error_signature
    UpdateFailure.SIGNER_MISMATCH -> R.string.update_error_signer_mismatch
    UpdateFailure.USER_CANCELLED -> R.string.update_error_cancelled
    UpdateFailure.BLOCKED -> R.string.update_error_blocked
    UpdateFailure.INVALID -> R.string.update_error_not_valid
    UpdateFailure.OTHER -> R.string.update_error_other
}

@Composable
private fun Stepper(label: String, value: Int, onMinus: () -> Unit, onPlus: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, Modifier.weight(1f))
        OutlinedButton(onClick = onMinus, modifier = Modifier.heightIn(min = 48.dp)) { Text("-") }
        Text(stringResource(R.string.settings_seconds, value), Modifier.padding(horizontal = 12.dp))
        OutlinedButton(onClick = onPlus, modifier = Modifier.heightIn(min = 48.dp)) { Text("+") }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun LanSection(vm: MainViewModel) {
    val context = LocalContext.current
    val lan by vm.lanState.collectAsState()
    val master by vm.settings.lanMaster.collectAsState()
    val port by vm.settings.lanPort.collectAsState()
    val manual by vm.settings.lanManual.collectAsState()
    var portText by rememberSaveable(port) { mutableStateOf(port.toString()) }
    var manualText by rememberSaveable { mutableStateOf(manual) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

    Text(stringResource(R.string.lan_title), style = MaterialTheme.typography.titleMedium)
    if (!lan.available && !master) {
        Text(stringResource(R.string.lan_unavailable), style = MaterialTheme.typography.bodyMedium)
        return
    }
    Text(stringResource(R.string.lan_hint), style = MaterialTheme.typography.bodySmall)
    LanStatusLine(lan)
    if (lan.health == org.tix.checkin.core.lan.LanHealth.KEY_OUTDATED) {
        Text(stringResource(R.string.lan_key_outdated_hint), color = MaterialTheme.colorScheme.error)
    }
    if (lan.health == org.tix.checkin.core.lan.LanHealth.CLOCK_SKEW) {
        Text(stringResource(R.string.lan_status_clock_skew), color = MaterialTheme.colorScheme.error)
    }
    if (lan.lastContactMillis > 0) {
        Text(stringResource(R.string.lan_last_contact, formatMillis(context, lan.lastContactMillis)), style = MaterialTheme.typography.bodySmall)
    }
    SwitchRow(stringResource(R.string.lan_master_toggle), master) { on ->
        if (on && android.os.Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            // The service runs without it; the permission only makes its notification visible.
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        vm.setLanMaster(on)
    }
    if (master) {
        Text(stringResource(R.string.lan_master_hint), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(
            value = portText,
            onValueChange = { v ->
                portText = v.filter { it.isDigit() }.take(5)
                portText.toIntOrNull()?.takeIf { it in 1024..65535 }?.let(vm::setLanPort)
            },
            label = { Text(stringResource(R.string.lan_port)) },
            isError = portText.toIntOrNull()?.let { it !in 1024..65535 } ?: true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    } else {
        val valid = vm.isValidLanManual(manualText)
        OutlinedTextField(
            value = manualText,
            onValueChange = { manualText = it; if (vm.isValidLanManual(it)) vm.setLanManual(it) },
            label = { Text(stringResource(R.string.lan_manual)) },
            supportingText = { Text(stringResource(if (valid) R.string.lan_manual_hint else R.string.lan_manual_invalid)) },
            isError = !valid,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
