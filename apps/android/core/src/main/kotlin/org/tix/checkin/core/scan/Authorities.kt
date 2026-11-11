package org.tix.checkin.core.scan

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import org.tix.checkin.core.ParsedTicketPayload
import org.tix.checkin.core.TicketCode
import org.tix.checkin.core.TicketInvalidReason
import org.tix.checkin.core.TicketPayload
import org.tix.checkin.core.TicketVerifyResult
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.Clock
import org.tix.checkin.core.contract.Iso
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.ScanAction
import org.tix.checkin.core.contract.ScanColor
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.ScanResult
import org.tix.checkin.core.contract.ScanSource
import org.tix.checkin.core.contract.ScanTicketDisplay
import org.tix.checkin.core.contract.ScanWarning
import org.tix.checkin.core.contract.ScannerApi
import org.tix.checkin.core.contract.TicketStatus

/** Short seat description for lists: `Stalls / R B / S 7`. */
fun seatText(section: String?, row: String?, seat: String?): String =
    listOfNotNull(
        section?.takeIf { it.isNotBlank() },
        row?.takeIf { it.isNotBlank() }?.let { "R $it" },
        seat?.takeIf { it.isNotBlank() }?.let { "S $it" },
    ).joinToString(" / ")

/** Who a decision is made for: this device (default) or a LAN client whose scan the master decides. */
class DecideContext(
    val deviceName: String,
    /** Entrance of the scanning device (WRONG_ENTRANCE) - null = any. */
    val entranceId: String?,
    /** null = the event's own flag (this device). A LAN client checks its own permission before asking. */
    val checkOutAllowed: Boolean? = null,
    /** true = the result is a LAN master decision: no journal row, state marked [LocalTicket.lanDirty]. */
    val lan: Boolean = false,
)

/** A decision with everything needed to persist it; nothing has been written yet. */
class Decided(
    val verdict: ScanVerdict,
    /** The journal row for this device's upload queue (null: not recorded, e.g. event not assigned). */
    val journal: JournalEntry?,
    /** The row to write after the decision (state change); null = nothing to write. */
    val updated: LocalTicket?,
    /** The ticket as it is after the decision (also for rejections): what the scanning device should learn. */
    val current: LocalTicket?,
)

/**
 * Offline decisions on this device (docs/SCANNER.md decision table + "offline admits a valid
 * signature without a local record"). Writes the journal and the new ticket state immediately so
 * a second scan of the same ticket on this device is RED. [decide] is the pure part (also used by the
 * LAN master for its clients). [lock] serialises every read-modify-write of the local ticket rows.
 */
class LocalScanAuthority(
    private val config: () -> ConfigSnapshot,
    private val store: ScanStore,
    private val lock: Mutex = Mutex(),
) : ScanAuthority {

    override suspend fun scan(command: ScanCommand): ScanVerdict = lock.withLock {
        val d = decide(command)
        d.journal?.let { store.commit(it, d.updated) }
        d.verdict
    }

    /**
     * Decides without writing. The caller holds the database lock. [expectedEventId] (LAN master: the event of
     * the authenticated envelope) makes a ticket of any other event RED `REJECTED_WRONG_EVENT`, whatever the
     * payload or the ticket row says - the master must never admit a guest on a key of another event.
     */
    suspend fun decide(command: ScanCommand, ctx: DecideContext? = null, expectedEventId: String? = null): Decided {
        val cfg = config()
        if (!cfg.offlineModeAllowed) {
            return Decided(
                ScanVerdict(
                    command.clientScanId, command.action, result = null, color = ScanColor.RED,
                    decidedBy = DecidedBy.LOCAL, notice = VerdictNotice.OFFLINE_NOT_ALLOWED,
                ),
                null, null, null,
            )
        }
        val deviceName = ctx?.deviceName ?: cfg.deviceName
        val lan = ctx?.lan == true
        val decidedBy = if (lan) DecidedBy.LAN else DecidedBy.LOCAL

        // 1. Which event / ticket? Camera: the payload. Manual: the ticket row.
        var eventId = command.eventId
        var ticketId: String? = command.ticketId
        var parsed: ParsedTicketPayload? = null
        var ticket: LocalTicket? = null
        if (command.source == ScanSource.CAMERA) {
            val payload = command.payload ?: return rejected(cfg, command, ScanResult.REJECTED_MALFORMED, ctx = ctx)
            val p = TicketPayload.parse(payload) ?: return rejected(cfg, command, ScanResult.REJECTED_MALFORMED, ctx = ctx)
            if (expectedEventId != null && p.eventId != expectedEventId) {
                return rejected(cfg, command, ScanResult.REJECTED_WRONG_EVENT, expectedEventId, p.ticketId, ctx)
            }
            parsed = p
            eventId = p.eventId
            ticketId = p.ticketId
        } else {
            val byId = command.ticketId
            val byCode = command.ticketCode
            ticket = when {
                byId != null -> store.ticket(byId)
                byCode != null -> store.ticketByCode(command.eventId, TicketCode.normalize(byCode))
                else -> null
            }
            if (expectedEventId != null && ticket != null && ticket.eventId != expectedEventId) {
                return rejected(cfg, command, ScanResult.REJECTED_WRONG_EVENT, expectedEventId, ticket.id, ctx)
            }
            ticket?.let {
                eventId = it.eventId
                ticketId = it.id
            }
        }
        if (expectedEventId != null && eventId != expectedEventId) {
            return rejected(cfg, command, ScanResult.REJECTED_WRONG_EVENT, expectedEventId, ticketId, ctx)
        }

        val event = cfg.events[eventId] ?: return notAssigned(command, decidedBy)
        val entrance = if (ctx != null) ctx.entranceId else event.entranceId

        // 2. Signature (camera only). The expected event is the payload's event, which is assigned.
        if (parsed != null) {
            val verdict = TicketPayload.verify(parsed, eventId) { _, keyId -> event.keys[keyId] }
            if (verdict is TicketVerifyResult.Invalid) {
                val result = when (verdict.reason) {
                    TicketInvalidReason.MALFORMED -> ScanResult.REJECTED_MALFORMED
                    TicketInvalidReason.WRONG_EVENT -> ScanResult.REJECTED_WRONG_EVENT
                    TicketInvalidReason.UNKNOWN_KEY, TicketInvalidReason.BAD_SIGNATURE -> ScanResult.REJECTED_INVALID_SIGNATURE
                }
                return rejected(cfg, command, result, eventId, ticketId, ctx)
            }
            val row = store.ticket(parsed.ticketId)
            // The same ticket id under another event is a conflict, never an unknown ticket: a provisional stub
            // would replace that row (the id is the primary key).
            if (row != null && row.eventId != eventId) return rejected(cfg, command, ScanResult.REJECTED_WRONG_EVENT, eventId, ticketId, ctx)
            ticket = row
        }

        // 3. Unknown ticket with a valid signature: it may have been sold after the last sync, so
        //    a check-in is admitted on the signature alone (uploaded and merged later).
        if (ticket == null) {
            if (parsed == null || command.action != ScanAction.CHECK_IN) {
                return rejected(cfg, command, ScanResult.REJECTED_UNKNOWN_TICKET, eventId, ticketId, ctx)
            }
            return admitProvisional(command, event, parsed, deviceName, entrance, lan)
        }

        // 4. The decision table.
        val type = event.ticketTypes[ticket.ticketTypeId]
        val decision = decideScan(
            DecisionInput(
                action = command.action,
                ticket = DecisionTicket(
                    status = ticket.status,
                    checkInState = ticket.checkInState,
                    requiresProof = type?.requiresProof ?: false,
                    seatFeature = ticket.seatFeature,
                    additionalPaymentOpen = ticket.additionalPaymentOpen,
                    entranceId = event.sectionEntrances[ticket.sectionId],
                ),
                deviceEntranceId = entrance,
                checkOutAllowed = ctx?.checkOutAllowed ?: event.allowCheckOut,
            ),
        )
        val texts = buildMap {
            if (ScanWarning.DISCOUNT_PROOF_REQUIRED in decision.warnings) {
                type?.scannerWarning?.takeIf { it.isNotBlank() }
                    ?.let { put(ScanWarning.DISCOUNT_PROOF_REQUIRED.name, it) }
            }
        }
        val updated = if (decision.nextState != null) {
            if (lan) {
                Merge.afterLanDecision(ticket, decision, command.scannedAtMillis, deviceName)
            } else {
                Merge.afterLocalScan(ticket, decision, command.scannedAtMillis, deviceName)
            }
        } else {
            null
        }
        val shown = (updated ?: ticket).display(type?.name.orEmpty())
        return Decided(
            verdict = ScanVerdict(
                clientScanId = command.clientScanId,
                action = command.action,
                result = decision.result,
                color = decision.result.color,
                warnings = decision.warnings,
                warningTexts = texts,
                ticket = shown,
                // The first check-in as recorded BEFORE this scan (a duplicate shows who got in first).
                firstScan = ticket.firstScan(),
                decidedBy = decidedBy,
            ),
            journal = journal(command, eventId, ticket.id, decision.result, decision.warnings, texts, shown, entrance, decidedBy),
            updated = updated,
            current = updated ?: ticket,
        )
    }

    private fun admitProvisional(
        command: ScanCommand,
        event: EventConfig,
        parsed: ParsedTicketPayload,
        deviceName: String,
        entrance: String?,
        lan: Boolean,
    ): Decided {
        val at = Iso.format(command.scannedAtMillis)
        val stub = if (lan) {
            Merge.provisionalFromLan(event.id, parsed.ticketId, parsed.keyId, parsed.seatInfo, command.scannedAtMillis, deviceName)
        } else {
            LocalTicket(
                id = parsed.ticketId, ticketCode = "", status = TicketStatus.VALID, eventId = event.id, keyId = parsed.keyId,
                sectionId = "", sectionLabel = parsed.seatInfo, rowLabel = null, seatLabel = null, seatFeature = null,
                categoryId = "", categoryName = "", ticketTypeId = "", attendeeName = null,
                checkInState = CheckInState.CHECKED_IN, firstCheckedInAt = at, firstCheckedInDeviceName = deviceName,
                checkInCount = 1, lastScanAt = at, additionalPaymentOpen = false, syncVersion = 0,
                provisional = true, localDirty = true,
            )
        }
        val shown = stub.display()
        val decidedBy = if (lan) DecidedBy.LAN else DecidedBy.LOCAL
        return Decided(
            verdict = ScanVerdict(
                clientScanId = command.clientScanId, action = command.action, result = ScanResult.ACCEPTED,
                color = ScanColor.GREEN, ticket = shown, decidedBy = decidedBy, provisional = true,
            ),
            journal = journal(command, event.id, parsed.ticketId, ScanResult.ACCEPTED, emptyList(), emptyMap(), shown, entrance, decidedBy),
            updated = stub,
            current = stub,
        )
    }

    private fun rejected(
        cfg: ConfigSnapshot,
        command: ScanCommand,
        result: ScanResult,
        eventId: String = command.eventId,
        ticketId: String? = command.ticketId,
        ctx: DecideContext?,
    ): Decided {
        val decidedBy = if (ctx?.lan == true) DecidedBy.LAN else DecidedBy.LOCAL
        // Only scans of an assigned event are journaled (the server does not record the others either).
        val event = cfg.events[eventId]
        val entry = event?.let {
            journal(command, eventId, ticketId, result, emptyList(), emptyMap(), null, if (ctx != null) ctx.entranceId else it.entranceId, decidedBy)
        }
        return Decided(ScanVerdict(command.clientScanId, command.action, result, result.color, decidedBy = decidedBy), entry, null, null)
    }

    private fun notAssigned(command: ScanCommand, decidedBy: DecidedBy) = Decided(
        ScanVerdict(
            command.clientScanId, command.action, ScanResult.REJECTED_WRONG_EVENT, ScanColor.RED,
            decidedBy = decidedBy, notice = VerdictNotice.EVENT_NOT_ASSIGNED,
        ),
        null, null, null,
    )

    private fun journal(
        command: ScanCommand,
        eventId: String,
        ticketId: String?,
        result: ScanResult,
        warnings: List<ScanWarning>,
        texts: Map<String, String>,
        shown: ScanTicketDisplay?,
        entranceId: String?,
        decidedBy: DecidedBy,
    ) = JournalEntry(
        clientScanId = command.clientScanId,
        eventId = eventId,
        ticketId = ticketId,
        ticketCode = command.ticketCode,
        payload = command.payload?.take(ScanCommand.PAYLOAD_UPLOAD_MAX),
        action = command.action,
        source = command.source,
        result = result,
        warnings = warnings,
        warningTexts = texts,
        scannedAtMillis = command.scannedAtMillis,
        entranceId = entranceId,
        decidedBy = decidedBy,
        uploaded = false,
        attendeeName = shown?.attendeeName,
        seatLabel = shown?.let { seatText(it.sectionLabel, it.rowLabel, it.seatLabel) },
        categoryName = shown?.categoryName?.takeIf { it.isNotBlank() },
    )
}

/** Sends the scan to the server (`POST /scan`) and records the server's answer in the journal. */
class ServerScanAuthority(
    private val api: ScannerApi,
    private val store: ScanStore,
    private val timeoutMillis: Long = 1_500,
    private val lock: Mutex = Mutex(),
) : ScanAuthority {
    override suspend fun scan(command: ScanCommand): ScanVerdict {
        val outcome: ScanOutcome = try {
            withTimeout(timeoutMillis) { api.scan(command.toRequest()) }
        } catch (e: TimeoutCancellationException) {
            throw NetworkException("scan timed out after ${timeoutMillis}ms", e)
        }
        val shown = outcome.ticket
        val ticketId = shown?.id ?: command.ticketId
        // Read-modify-write of the ticket row after the (slow) network call: serialised with local/LAN writes.
        lock.withLock {
            val local = ticketId?.let { store.ticket(it) }
            val patched = Merge.afterServerScan(local, outcome, command.action, command.scannedAtMillis)
            store.commit(
                JournalEntry(
                    clientScanId = command.clientScanId,
                    eventId = command.eventId,
                    ticketId = ticketId,
                    ticketCode = command.ticketCode,
                    payload = command.payload?.take(ScanCommand.PAYLOAD_UPLOAD_MAX),
                    action = command.action,
                    source = command.source,
                    result = outcome.result,
                    warnings = outcome.warnings,
                    warningTexts = outcome.warningTexts,
                    scannedAtMillis = command.scannedAtMillis,
                    entranceId = command.entranceId,
                    decidedBy = DecidedBy.SERVER,
                    uploaded = true,
                    serverResult = outcome.result,
                    attendeeName = shown?.attendeeName,
                    seatLabel = shown?.let { seatText(it.sectionLabel, it.rowLabel, it.seatLabel) },
                    categoryName = shown?.categoryName?.takeIf { it.isNotBlank() },
                ),
                patched,
            )
        }
        return ScanVerdict(
            clientScanId = outcome.clientScanId,
            action = command.action,
            result = outcome.result,
            color = outcome.result.color,
            warnings = outcome.warnings,
            warningTexts = outcome.warningTexts,
            ticket = shown,
            firstScan = outcome.firstScan,
            decidedBy = DecidedBy.SERVER,
        )
    }
}

/** Reachability of the server as seen by the app (fed by every request). */
interface ServerLink {
    /** false = do not even try the server for scans (offline / maintenance / unreachable). */
    fun isUsable(): Boolean
    fun onSuccess()
    fun onFailure(error: Throwable)
}

/**
 * Server first, then the LAN master (optional), then this device alone: a slow or failing server
 * never stalls the queue. A fallback decision reuses the command's `clientScanId`, so a scan the
 * server did process after all is recognised as a duplicate when the journal is uploaded (the server
 * result wins).
 */
class FallbackScanAuthority(
    private val server: ScanAuthority,
    private val local: ScanAuthority,
    private val link: ServerLink,
    private val store: ScanStore,
    /** The LAN master client authority; null on the master itself and when LAN is off. */
    private val lan: ScanAuthority? = null,
) : ScanAuthority {
    override suspend fun scan(command: ScanCommand): ScanVerdict {
        // A ticket with an unsent local state is unknown to the server: never ask the server about it.
        val dirty = unsentLocalTicket(command)
        if (!link.isUsable() || dirty != null) return offline(command, dirty)
        return try {
            server.scan(command).also { link.onSuccess() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            if (e.isEventNotAssigned) {
                link.onSuccess()
                ScanVerdict(
                    command.clientScanId, command.action, ScanResult.REJECTED_WRONG_EVENT, ScanColor.RED,
                    decidedBy = DecidedBy.SERVER, notice = VerdictNotice.EVENT_NOT_ASSIGNED,
                )
            } else {
                link.onFailure(e)
                offline(command, null)
            }
        } catch (e: Exception) {
            link.onFailure(e)
            offline(command, null)
        }
    }

    /**
     * Server unusable: ask the LAN master, which knows the other doors; if it cannot answer decide here.
     * Exception: this device's own unsent state already makes the answer RED - the master may not know
     * that scan yet and would wrongly admit the guest a second time.
     */
    private suspend fun offline(command: ScanCommand, dirty: LocalTicket?): ScanVerdict {
        val knownRed = dirty != null && (
            (command.action == ScanAction.CHECK_IN && dirty.checkInState == CheckInState.CHECKED_IN) ||
                (command.action == ScanAction.CHECK_OUT && dirty.checkInState != CheckInState.CHECKED_IN)
            )
        if (lan != null && !knownRed) {
            try {
                return lan.scan(command)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // master unreachable / refused: decide on this device
            }
        }
        return local.scan(command)
    }

    /** The ticket was scanned on this device and that scan is not uploaded yet: the server cannot know it. */
    private suspend fun unsentLocalTicket(command: ScanCommand): LocalTicket? {
        val id = command.ticketId ?: command.payload?.let { TicketPayload.parse(it)?.ticketId } ?: return null
        return store.ticket(id)?.takeIf { it.localDirty }
    }
}

/** Builds [ScanCommand]s (ids, corrected time, entrance) and serialises scans: one decision at a time. */
class ScanCoordinator(
    private val authority: ScanAuthority,
    private val config: () -> ConfigSnapshot,
    private val clock: Clock,
    private val newId: () -> String = { java.util.UUID.randomUUID().toString() },
) {
    private val mutex = Mutex()

    /**
     * A camera scan. [selectedEventId] is the event chosen in the app; the payload's event decides
     * when it is one of the assigned events (a device may scan several events at once).
     */
    suspend fun scanCode(raw: String, action: ScanAction, selectedEventId: String): ScanVerdict {
        val cfg = config()
        val payloadEvent = TicketPayload.parse(raw)?.eventId
        val eventId = if (payloadEvent != null && cfg.events.containsKey(payloadEvent)) payloadEvent else selectedEventId
        return run(
            ScanCommand(
                clientScanId = newId(), eventId = eventId, action = action, source = ScanSource.CAMERA,
                payload = raw.take(ScanCommand.PAYLOAD_UPLOAD_MAX), scannedAtMillis = clock.nowMillis(),
                entranceId = cfg.events[eventId]?.entranceId,
            ),
        )
    }

    /** A manual scan of a ticket picked from the lookup list. */
    suspend fun scanTicket(ticketId: String, eventId: String, action: ScanAction): ScanVerdict {
        val cfg = config()
        return run(
            ScanCommand(
                clientScanId = newId(), eventId = eventId, action = action, source = ScanSource.MANUAL,
                ticketId = ticketId, scannedAtMillis = clock.nowMillis(), entranceId = cfg.events[eventId]?.entranceId,
            ),
        )
    }

    private suspend fun run(command: ScanCommand): ScanVerdict = mutex.withLock { authority.scan(command) }
}
