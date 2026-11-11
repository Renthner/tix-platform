package org.tix.checkin.core

import kotlinx.serialization.Serializable
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.ScannerJson
import org.tix.checkin.core.scan.JournalEntry

/** One scan of the export file: what is needed to re-apply it by hand or by a script (no names, no secrets). */
@Serializable
data class ExportedScan(
    val clientScanId: String,
    val eventId: String,
    /** From the signed payload (or the manual pick); the payload itself is NOT exported: it would be a usable ticket. */
    val ticketId: String? = null,
    val action: String,
    val source: String,
    val result: String,
    val scannedAt: String,
    val entranceId: String? = null,
    val decidedBy: String,
    /** Set when the server refused this scan as a request (quarantined). */
    val uploadError: String? = null,
)

@Serializable
data class ScanExportFile(
    val format: String = FORMAT,
    val exportedAt: String,
    val deviceName: String,
    val scans: List<ExportedScan>,
) {
    companion object {
        const val FORMAT = "tix-unsent-scans-v1"
    }
}

/**
 * Export of the scans that were never delivered to the server, offered before an unpair wipes them (the device
 * token is gone then, so they cannot be uploaded any more). The device token is never part of the file.
 */
object ScanExport {
    fun toJson(entries: List<JournalEntry>, deviceName: String, nowMillis: Long): String =
        ScannerJson.encodeToString(
            ScanExportFile(
                exportedAt = Iso.format(nowMillis),
                deviceName = deviceName,
                scans = entries.map {
                    ExportedScan(
                        clientScanId = it.clientScanId, eventId = it.eventId, ticketId = it.payload?.let { p -> TicketPayload.parse(p)?.ticketId } ?: it.ticketId,
                        action = it.action.name, source = it.source.name,
                        result = it.result.name, scannedAt = Iso.format(it.scannedAtMillis), entranceId = it.entranceId,
                        decidedBy = it.decidedBy.name, uploadError = it.uploadError,
                    )
                },
            ),
        )
}
