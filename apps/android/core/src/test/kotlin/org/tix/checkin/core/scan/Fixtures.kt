package org.tix.checkin.core.scan

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.tix.checkin.core.Base64Url
import org.tix.checkin.core.contract.CheckInState
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.SeatFeature
import org.tix.checkin.core.contract.SyncPage
import org.tix.checkin.core.contract.SyncTicket
import org.tix.checkin.core.contract.TicketStatus
import org.tix.checkin.core.lan.LanClientStore
import org.tix.checkin.core.lan.LanMasterStore
import org.tix.checkin.core.lan.LanTicketState
import org.tix.checkin.core.sync.JournalUploadStore
import org.tix.checkin.core.sync.TicketSyncStore

const val EVENT_A = "00000000-0000-4000-8000-0000000000a1"
const val EVENT_B = "00000000-0000-4000-8000-0000000000b1"
const val ENTRANCE_N = "00000000-0000-4000-8000-0000000000e1"
const val ENTRANCE_S = "00000000-0000-4000-8000-0000000000e2"
const val SECTION_N = "00000000-0000-4000-8000-0000000000c1"
const val SECTION_NONE = "00000000-0000-4000-8000-0000000000c2"
const val TYPE_NORMAL = "00000000-0000-4000-8000-0000000000d1"
const val TYPE_REDUCED = "00000000-0000-4000-8000-0000000000d2"

/** Deterministic signing keys: Ed25519 from a fixed seed, like the vector in docs/TICKETS.md. */
object TestKeys {
    val seed = ByteArray(32) { it.toByte() }
    val otherSeed = ByteArray(32) { (it + 100).toByte() }

    fun publicKey(seed: ByteArray): ByteArray = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded

    private fun sign(message: String, seed: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(seed, 0))
        val bytes = message.toByteArray(Charsets.UTF_8)
        signer.update(bytes, 0, bytes.size)
        return signer.generateSignature()
    }

    private fun uuidB64(u: String): String {
        val hex = u.replace("-", "")
        return Base64Url.encode(ByteArray(16) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() })
    }

    fun payload(
        ticketId: String,
        eventId: String = EVENT_A,
        keyId: String = "k1",
        seatInfo: String = "Stalls|B|7",
        signWith: ByteArray = seed,
    ): String {
        val input = "tix://v1/$keyId.${uuidB64(eventId)}.${uuidB64(ticketId)}." +
            Base64Url.encode(seatInfo.toByteArray(Charsets.UTF_8))
        return "$input.${Base64Url.encode(sign(input, signWith))}"
    }
}

fun ticketId(n: Int) = "10000000-0000-4000-8000-%012d".format(n)

fun localTicket(
    n: Int = 1,
    eventId: String = EVENT_A,
    status: TicketStatus = TicketStatus.VALID,
    state: CheckInState = CheckInState.NONE,
    type: String = TYPE_NORMAL,
    section: String = SECTION_NONE,
    feature: SeatFeature? = null,
    additionalPaymentOpen: Boolean = false,
    attendee: String? = "Max Muster",
) = LocalTicket(
    id = ticketId(n), ticketCode = "ABCDEFGH%02d".format(n), status = status, eventId = eventId, keyId = "k1",
    sectionId = section, sectionLabel = "Stalls", rowLabel = "B", seatLabel = n.toString(), seatFeature = feature,
    categoryId = "cat", categoryName = "Cat 1", ticketTypeId = type, attendeeName = attendee, checkInState = state,
    firstCheckedInAt = null, firstCheckedInDeviceName = null, checkInCount = 0, lastScanAt = null,
    additionalPaymentOpen = additionalPaymentOpen, syncVersion = n.toLong(),
)

fun config(
    offlineAllowed: Boolean = true,
    allowCheckOut: Boolean = true,
    entrance: String? = null,
    revokedKey: Boolean = false,
    deviceName: String = "Door A",
    deviceId: String = "",
    lanSecret: ByteArray? = null,
): ConfigSnapshot = ConfigSnapshot(
    offlineModeAllowed = offlineAllowed,
    deviceName = deviceName,
    deviceId = deviceId,
    events = mapOf(
        EVENT_A to EventConfig(
            id = EVENT_A, title = "Show", entranceId = entrance, allowCheckOut = allowCheckOut,
            keys = if (revokedKey) emptyMap() else mapOf("k1" to TestKeys.publicKey(TestKeys.seed)),
            ticketTypes = mapOf(
                TYPE_NORMAL to TicketTypeConfig(TYPE_NORMAL, "Normal", false, null),
                TYPE_REDUCED to TicketTypeConfig(TYPE_REDUCED, "Reduced", true, "Bitte Ermaessigungsnachweis pruefen!"),
            ),
            sectionEntrances = mapOf(SECTION_N to ENTRANCE_N, SECTION_NONE to null),
            lanSecret = lanSecret,
        ),
    ),
)

/** In-memory database used by the authority, upload and sync tests. */
class FakeDb : ScanStore, JournalUploadStore, TicketSyncStore, LanMasterStore, LanClientStore {
    val tickets = LinkedHashMap<String, LocalTicket>()
    val journal = ArrayList<JournalEntry>()
    val cursors = HashMap<String, String>()
    val pages = ArrayList<SyncPage>()

    override suspend fun ticket(id: String) = tickets[id]
    override suspend fun ticketByCode(eventId: String, code: String) =
        tickets.values.firstOrNull { it.eventId == eventId && it.ticketCode == code }

    private var journalSeq = 0L

    override suspend fun commit(entry: JournalEntry, ticket: LocalTicket?) {
        journal += entry.copy(rowId = ++journalSeq)
        if (ticket != null) tickets[ticket.id] = ticket
    }

    override suspend fun pending(limit: Int) =
        journal.filter { !it.uploaded }.sortedBy { it.scannedAtMillis }.take(limit)

    private fun replace(entry: JournalEntry) {
        journal[journal.indexOfFirst { it.clientScanId == entry.clientScanId }] = entry
    }

    private fun otherPending(entry: JournalEntry) =
        journal.any { !it.uploaded && it.ticketId == entry.ticketId && it.clientScanId != entry.clientScanId }

    override suspend fun applyOutcome(entry: JournalEntry, outcome: ScanOutcome) {
        val m = Merge.applyOutcome(entry, outcome, entry.ticketId?.let { tickets[it] }, otherPending(entry))
        replace(m.entry)
        m.ticket?.let { tickets[it.id] = it }
    }

    var appVersion = 1
    val quarantineVersions = HashMap<String, Int>()

    override suspend fun quarantine(entry: JournalEntry, error: String) {
        val m = Merge.quarantine(entry, entry.ticketId?.let { tickets[it] }, error, otherPending(entry))
        replace(m.entry)
        quarantineVersions[entry.clientScanId] = appVersion
        m.ticket?.let { tickets[it.id] = it }
    }

    override suspend fun requeueQuarantined(appVersion: Int) {
        for (i in journal.indices) {
            val e = journal[i]
            if (e.uploaded && e.uploadError != null && quarantineVersions[e.clientScanId] != appVersion) {
                journal[i] = e.copy(uploaded = false, uploadError = null)
            }
        }
    }

    // ─── LAN (master + client) ───
    var lanSeq = 0L
    var lanEpoch = "epoch-1"
    val lanCursors = HashMap<String, Long>()
    val lanEpochs = HashMap<String, String>()
    val reportedUpTo = HashMap<String, Long>()

    override suspend fun commitLan(ticket: LocalTicket) {
        tickets[ticket.id] = ticket.copy(lanSeq = ++lanSeq)
    }

    override suspend fun lanEpoch() = lanEpoch

    override suspend fun epoch(masterId: String, eventId: String) = lanEpochs["$masterId/$eventId"]

    override suspend fun setEpoch(masterId: String, eventId: String, epoch: String) {
        lanEpochs["$masterId/$eventId"] = epoch
    }

    override suspend fun changedSince(eventId: String, seq: Long, limit: Int) =
        tickets.values.filter { it.eventId == eventId && it.lanSeq > seq }.sortedBy { it.lanSeq }.take(limit)

    override suspend fun maxLanSeq() = lanSeq

    override suspend fun cursor(masterId: String, eventId: String) = lanCursors["$masterId/$eventId"] ?: 0L

    override suspend fun setCursor(masterId: String, eventId: String, cursor: Long) {
        lanCursors["$masterId/$eventId"] = cursor
    }

    override suspend fun applyStates(states: List<LanTicketState>) {
        for (s in states) Merge.adoptLanState(tickets[s.ticketId], s, markLocalDirty = false)?.let { tickets[it.id] = it }
    }

    override suspend fun unreportedLocalScans(masterId: String, eventId: String, limit: Int) =
        journal.filter { it.decidedBy == DecidedBy.LOCAL && it.eventId == eventId && it.rowId > (reportedUpTo["$masterId/$eventId"] ?: 0) }
            .sortedBy { it.rowId }.take(limit)

    override suspend fun markReported(masterId: String, eventId: String, entries: List<JournalEntry>) {
        val key = "$masterId/$eventId"
        reportedUpTo[key] = maxOf(reportedUpTo[key] ?: 0, entries.maxOf { it.rowId })
    }

    override suspend fun cursor(eventId: String) = cursors[eventId]

    override suspend fun applyPage(eventId: String, page: SyncPage) {
        pages += page
        // Same as the Room store: rows that change what the LAN must learn get a new feed position.
        for (row in Merge.mergePage(tickets, page.tickets)) {
            tickets[row.ticket.id] = if (row.lanChanged) row.ticket.copy(lanSeq = ++lanSeq) else row.ticket
        }
        cursors[eventId] = page.nextCursor
    }
}

fun syncTicket(n: Int, version: Long, status: TicketStatus = TicketStatus.VALID, state: CheckInState = CheckInState.NONE) =
    SyncTicket(
        id = ticketId(n), ticketCode = "ABCDEFGH%02d".format(n), status = status, eventId = EVENT_A,
        checkInState = state, syncVersion = version,
    )
