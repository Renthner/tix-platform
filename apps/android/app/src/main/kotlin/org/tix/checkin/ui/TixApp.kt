package org.tix.checkin.ui

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import org.tix.checkin.R

private enum class Destination(val route: String, val label: Int, val icon: Int) {
    Events("events", R.string.nav_events, R.drawable.ic_nav_events),
    Scanner("scanner", R.string.nav_scanner, R.drawable.ic_nav_scan),
    Lookup("lookup", R.string.nav_lookup, R.drawable.ic_nav_lookup),
    History("history", R.string.nav_history, R.drawable.ic_nav_history),
    Settings("settings", R.string.nav_settings, R.drawable.ic_nav_settings),
}

@Composable
fun TixApp() {
    val app = LocalContext.current.applicationContext as Application
    val vm: MainViewModel = viewModel(factory = MainViewModel.factory(app))
    val paired by vm.paired.collectAsState()
    val verdict by vm.verdict.collectAsState()
    val block by vm.unpairBlock.collectAsState()

    val pendingUnpair = block
    if (pendingUnpair != null) {
        // Unsent scans and a dead token: nothing is wiped before the operator exported or discarded them.
        UnpairBlockedScreen(vm, pendingUnpair)
        return
    }
    when (paired) {
        null -> Box(Modifier.fillMaxSize())
        false -> PairingScreen(vm)
        true -> PairedApp(vm)
    }
    // The result covers everything (also the manual lookup) until dismissed.
    if (paired == true) verdict?.let { ResultOverlay(vm, it) }
}

@Composable
private fun PairedApp(vm: MainViewModel) {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val current = backStack?.destination?.route
    val selected by vm.selectedEvent.collectAsState()
    val events by vm.events.collectAsState()
    val syncStatus by vm.syncStatus.collectAsState()

    fun go(dest: Destination) {
        navController.navigate(dest.route) {
            popUpTo(Destination.Events.route) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    // Several events and none chosen yet: start on the event list, otherwise straight to the scanner.
    LaunchedEffect(selected == null, events.size) {
        if (selected != null && current == Destination.Events.route && events.size == 1) go(Destination.Scanner)
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                Destination.entries.forEach { dest ->
                    NavigationBarItem(
                        selected = current == dest.route,
                        onClick = { go(dest) },
                        icon = {
                            Icon(painterResource(dest.icon), contentDescription = stringResource(dest.label))
                        },
                        label = { Text(stringResource(dest.label), maxLines = 1) },
                        alwaysShowLabel = true,
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            if (syncStatus.tokenUnavailable) {
                // The Android Keystore cannot decrypt the device token. Nothing is unpaired or wiped; scans keep working offline.
                Surface(color = MaterialTheme.colorScheme.errorContainer) {
                    Text(
                        stringResource(R.string.error_token_unavailable),
                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        NavHost(
            navController = navController,
            startDestination = Destination.Events.route,
            modifier = Modifier.weight(1f),
        ) {
            composable(Destination.Events.route) { EventsScreen(vm, onSelected = { go(Destination.Scanner) }) }
            composable(Destination.Scanner.route) { ScannerScreen(vm, onChooseEvent = { go(Destination.Events) }) }
            composable(Destination.Lookup.route) { LookupScreen(vm, onChooseEvent = { go(Destination.Events) }) }
            composable(Destination.History.route) { HistoryScreen(vm) }
            composable(Destination.Settings.route) { SettingsScreen(vm) }
        }
        }
    }
}
