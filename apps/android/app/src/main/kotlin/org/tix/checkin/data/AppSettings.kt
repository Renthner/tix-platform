package org.tix.checkin.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.tix.checkin.core.UpdateChannel
import org.tix.checkin.core.UpdateSource
import org.tix.checkin.core.contract.ManifestAppUpdate
import org.tix.checkin.core.lan.LAN_DEFAULT_PORT

/** Where and on which channel the app looks for updates (delivered by the server manifest). */
data class AppUpdateConfig(
    val source: UpdateSource = UpdateSource.SERVER,
    val githubRepository: String = "",
    val defaultChannel: UpdateChannel = UpdateChannel.STABLE,
    val allowChannelOverride: Boolean = true,
)

/** Local (per device) preferences. No secrets here: the token lives encrypted in the database. */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("tix_settings", Context.MODE_PRIVATE)

    private val _greenSeconds = MutableStateFlow(prefs.getInt(KEY_GREEN, 2))
    private val _alertSeconds = MutableStateFlow(prefs.getInt(KEY_ALERT, 4))
    private val _sound = MutableStateFlow(prefs.getBoolean(KEY_SOUND, true))
    private val _vibrate = MutableStateFlow(prefs.getBoolean(KEY_VIBRATE, true))
    private val _selectedEvent = MutableStateFlow(prefs.getString(KEY_EVENT, null))
    private val _pairingNotice = MutableStateFlow(prefs.getString(KEY_NOTICE, null))

    private val _lanMaster = MutableStateFlow(prefs.getBoolean(KEY_LAN_MASTER, false))
    private val _lanPort = MutableStateFlow(prefs.getInt(KEY_LAN_PORT, LAN_DEFAULT_PORT))
    private val _lanManual = MutableStateFlow(prefs.getString(KEY_LAN_MANUAL, "").orEmpty())

    private val _appUpdate = MutableStateFlow(readAppUpdate())
    private val _channelOverride = MutableStateFlow(UpdateChannel.fromWire(prefs.getString(KEY_UPD_CHANNEL, null)))

    /** Update source from the last manifest; until one arrived the server (legacy) is assumed. */
    val appUpdate: StateFlow<AppUpdateConfig> = _appUpdate

    /** False until a manifest with (or without, older server) update settings was stored: the manifest is then fetched without ETag. */
    val appUpdateKnown: Boolean get() = prefs.contains(KEY_UPD_SOURCE)

    /** The operator's own channel choice (only used when the server allows it). */
    val channelOverride: StateFlow<UpdateChannel?> = _channelOverride

    /** The server's repository, else the one built into the app (CI: -Ptix.updateRepository); empty = none. */
    fun effectiveRepository(): String =
        org.tix.checkin.core.GithubReleases.effectiveRepository(_appUpdate.value.githubRepository, org.tix.checkin.BuildConfig.UPDATE_REPOSITORY)

    fun effectiveChannel(): UpdateChannel =
        UpdateChannel.effective(_appUpdate.value.defaultChannel, _appUpdate.value.allowChannelOverride, _channelOverride.value)

    private fun readAppUpdate() = AppUpdateConfig(
        source = UpdateSource.fromWire(prefs.getString(KEY_UPD_SOURCE, null)) ?: UpdateSource.SERVER,
        githubRepository = prefs.getString(KEY_UPD_REPO, "").orEmpty(),
        defaultChannel = UpdateChannel.fromWire(prefs.getString(KEY_UPD_DEFAULT, null)) ?: UpdateChannel.STABLE,
        allowChannelOverride = prefs.getBoolean(KEY_UPD_ALLOW, true),
    )

    /** Stores the manifest's update settings; null (older server) means "updates from the server". */
    fun setAppUpdate(m: ManifestAppUpdate?) {
        val cfg = if (m == null) AppUpdateConfig() else AppUpdateConfig(
            source = UpdateSource.fromWire(m.source) ?: UpdateSource.SERVER,
            githubRepository = m.githubRepository,
            defaultChannel = UpdateChannel.fromWire(m.defaultChannel) ?: UpdateChannel.STABLE,
            allowChannelOverride = m.allowChannelOverride,
        )
        _appUpdate.value = cfg
        prefs.edit()
            .putString(KEY_UPD_SOURCE, cfg.source.name).putString(KEY_UPD_REPO, cfg.githubRepository)
            .putString(KEY_UPD_DEFAULT, cfg.defaultChannel.wire).putBoolean(KEY_UPD_ALLOW, cfg.allowChannelOverride)
            .apply()
    }

    fun setChannelOverride(channel: UpdateChannel?) {
        _channelOverride.value = channel
        prefs.edit().apply { if (channel == null) remove(KEY_UPD_CHANNEL) else putString(KEY_UPD_CHANNEL, channel.wire) }.apply()
    }

    /** Unpair: the update settings belong to the old server. The channel choice is a device preference and stays. */
    fun clearAppUpdate() {
        prefs.edit().remove(KEY_UPD_SOURCE).remove(KEY_UPD_REPO).remove(KEY_UPD_DEFAULT).remove(KEY_UPD_ALLOW).apply()
        _appUpdate.value = AppUpdateConfig()
    }

    /** This device serves as the LAN master (only effective while the server delivers a LAN secret). */
    val lanMaster: StateFlow<Boolean> = _lanMaster
    val lanPort: StateFlow<Int> = _lanPort

    /** Optional `host:port` of a master when mDNS is blocked on the venue WiFi. */
    val lanManual: StateFlow<String> = _lanManual

    /** Seconds the GREEN result stays on screen. */
    val greenSeconds: StateFlow<Int> = _greenSeconds

    /** Seconds YELLOW / RED stay on screen. */
    val alertSeconds: StateFlow<Int> = _alertSeconds
    val sound: StateFlow<Boolean> = _sound
    val vibrate: StateFlow<Boolean> = _vibrate
    val selectedEventId: StateFlow<String?> = _selectedEvent

    /** Message for the pairing screen after the server unpaired this device ("revoked"). */
    val pairingNotice: StateFlow<String?> = _pairingNotice

    fun setGreenSeconds(v: Int) { _greenSeconds.value = v.coerceIn(1, 10); prefs.edit().putInt(KEY_GREEN, _greenSeconds.value).apply() }
    fun setAlertSeconds(v: Int) { _alertSeconds.value = v.coerceIn(2, 15); prefs.edit().putInt(KEY_ALERT, _alertSeconds.value).apply() }
    fun setSound(v: Boolean) { _sound.value = v; prefs.edit().putBoolean(KEY_SOUND, v).apply() }
    fun setVibrate(v: Boolean) { _vibrate.value = v; prefs.edit().putBoolean(KEY_VIBRATE, v).apply() }
    fun setSelectedEvent(id: String?) { _selectedEvent.value = id; prefs.edit().putString(KEY_EVENT, id).apply() }
    fun setPairingNotice(code: String?) { _pairingNotice.value = code; prefs.edit().putString(KEY_NOTICE, code).apply() }

    fun setLanMaster(v: Boolean) { _lanMaster.value = v; prefs.edit().putBoolean(KEY_LAN_MASTER, v).apply() }
    fun setLanPort(v: Int) { _lanPort.value = v.coerceIn(1024, 65535); prefs.edit().putInt(KEY_LAN_PORT, _lanPort.value).apply() }
    fun setLanManual(v: String) { _lanManual.value = v.trim(); prefs.edit().putString(KEY_LAN_MANUAL, _lanManual.value).apply() }

    /** Client LAN cursor of one master/event (position in the master change feed). */
    fun lanCursor(masterId: String, eventId: String): Long = prefs.getLong("lan_cursor_${masterId}_$eventId", 0)
    fun setLanCursor(masterId: String, eventId: String, v: Long) { prefs.edit().putLong("lan_cursor_${masterId}_$eventId", v).apply() }

    /** Counter generation of the master the cursor belongs to; a different value invalidates the cursor. */
    fun lanEpoch(masterId: String, eventId: String): String? = prefs.getString("lan_epoch_${masterId}_$eventId", null)
    fun setLanEpoch(masterId: String, eventId: String, v: String) { prefs.edit().putString("lan_epoch_${masterId}_$eventId", v).apply() }

    /**
     * Newest local journal row (position, not scan time) of the event already acknowledged by THIS master.
     * Per master: a new master gets every offline scan it has not acknowledged.
     */
    fun lanReportedUpTo(masterId: String, eventId: String): Long = prefs.getLong("lan_reported_${masterId}_$eventId", 0)
    fun setLanReportedUpTo(masterId: String, eventId: String, v: Long) { prefs.edit().putLong("lan_reported_${masterId}_$eventId", v).apply() }

    /** Forced resync / epoch change: the feed cursors (and the epochs they belong to) of every master. */
    fun clearLanCursors() {
        val e = prefs.edit()
        prefs.all.keys.filter { it.startsWith("lan_cursor_") || it.startsWith("lan_epoch_") }.forEach { e.remove(it) }
        e.apply()
    }

    /** Unpair: cursors and watermarks belong to the old pairing. */
    fun clearLanState() {
        val e = prefs.edit()
        prefs.all.keys.filter { it.startsWith("lan_cursor_") || it.startsWith("lan_epoch_") || it.startsWith("lan_reported_") }.forEach { e.remove(it) }
        e.putBoolean(KEY_LAN_MASTER, false).apply()
        _lanMaster.value = false
    }

    private companion object {
        const val KEY_UPD_SOURCE = "upd_source"
        const val KEY_UPD_REPO = "upd_repo"
        const val KEY_UPD_DEFAULT = "upd_default_channel"
        const val KEY_UPD_ALLOW = "upd_allow_override"
        const val KEY_UPD_CHANNEL = "upd_channel_override"
        const val KEY_LAN_MASTER = "lan_master"
        const val KEY_LAN_PORT = "lan_port"
        const val KEY_LAN_MANUAL = "lan_manual"
        const val KEY_GREEN = "green_seconds"
        const val KEY_ALERT = "alert_seconds"
        const val KEY_SOUND = "sound"
        const val KEY_VIBRATE = "vibrate"
        const val KEY_EVENT = "selected_event"
        const val KEY_NOTICE = "pairing_notice"
    }
}
