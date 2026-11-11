package org.tix.checkin.core.scan

import org.tix.checkin.core.Base64Url
import org.tix.checkin.core.contract.KeyStatus
import org.tix.checkin.core.contract.ManifestEvent
import org.tix.checkin.core.contract.ManifestSettings

/** Builds the in-memory configuration used for offline decisions from manifest data. */
object ConfigBuilder {
    fun build(deviceName: String, settings: ManifestSettings, events: List<ManifestEvent>, deviceId: String = ""): ConfigSnapshot =
        ConfigSnapshot(
            offlineModeAllowed = settings.offlineModeAllowed,
            deviceName = deviceName,
            events = events.associate { it.id to event(it, settings.lanSyncEnabled) },
            deviceId = deviceId,
        )

    private fun event(e: ManifestEvent, lanSyncEnabled: Boolean) = EventConfig(
        id = e.id,
        title = e.title,
        entranceId = e.entranceId,
        allowCheckOut = e.allowCheckOut,
        // REVOKED keys (or without key material) never verify; RETIRED keys still do.
        keys = e.keys
            .filter { it.status != KeyStatus.REVOKED && it.publicKey != null }
            .mapNotNull { k -> Base64Url.decode(k.publicKey!!)?.takeIf { it.size == 32 }?.let { k.keyId to it } }
            .toMap(),
        ticketTypes = e.ticketTypes.associate { it.id to TicketTypeConfig(it.id, it.name, it.requiresProof, it.scannerWarning) },
        sectionEntrances = e.sections.associate { it.id to it.entranceId },
        lanSecret = if (lanSyncEnabled && e.lan.enabled) e.lan.secret?.let { Base64Url.decode(it) }?.takeIf { it.size == 32 } else null,
    )
}
