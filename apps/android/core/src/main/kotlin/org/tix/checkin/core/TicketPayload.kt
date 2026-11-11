package org.tix.checkin.core

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.math.BigInteger
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

/**
 * Signed ticket QR payload "tix v1" - a byte-for-byte port of packages/shared/src/tickets/qr.ts
 * (specification and test vector: docs/TICKETS.md).
 *
 *     tix://v1/{keyId}.{eventId}.{ticketId}.{seatInfo}.{signature}
 */
object TicketPayload {
    const val PREFIX = "tix://v1/"
    const val SEAT_INFO_MAX_BYTES = 80
    private const val MAX_PAYLOAD_LENGTH = 400
    private val KEY_ID = Regex("[A-Za-z0-9_-]{1,16}")

    /** Group order L of Ed25519; a signature whose scalar half S is >= L is malleated (RFC 8032 5.1.7). */
    private val GROUP_ORDER = BigInteger("7237005577332262213973186563042994240857116359379907606001950938285454250989")

    /**
     * Pure syntax check (no crypto). Returns null for anything that is not a tix v1 payload.
     * Mirrors `parseTicketPayload`.
     */
    fun parse(payload: String): ParsedTicketPayload? {
        if (!payload.startsWith(PREFIX) || payload.length > MAX_PAYLOAD_LENGTH) return null
        val parts = payload.substring(PREFIX.length).split('.')
        if (parts.size != 5) return null
        val (keyId, eventB64, ticketB64, seatB64, sigB64) = parts
        if (!KEY_ID.matches(keyId)) return null
        val event = Base64Url.decode(eventB64)
        val ticket = Base64Url.decode(ticketB64)
        val seat = Base64Url.decode(seatB64)
        val signature = Base64Url.decode(sigB64)
        if (event?.size != 16 || ticket?.size != 16 || seat == null || signature?.size != 64) return null
        val seatInfo = decodeStrictUtf8(seat) ?: return null
        return ParsedTicketPayload(
            keyId = keyId,
            eventId = bytesToUuid(event),
            ticketId = bytesToUuid(ticket),
            seatInfo = seatInfo,
            signingInput = payload.substring(0, payload.lastIndexOf('.')),
            signature = signature,
        )
    }

    /**
     * Verifies syntax and signature offline. [expectedEventId] is the event the scanner is checking
     * in: a ticket of another event is rejected as WRONG_EVENT before any key lookup. The
     * [resolver] must look keys up by (eventId, keyId) and return null for unknown/revoked keys.
     */
    fun verify(
        payload: String,
        expectedEventId: String,
        resolver: PublicKeyResolver,
    ): TicketVerifyResult {
        val parsed = parse(payload) ?: return TicketVerifyResult.Invalid(TicketInvalidReason.MALFORMED)
        return verify(parsed, expectedEventId, resolver)
    }

    fun verify(
        parsed: ParsedTicketPayload,
        expectedEventId: String,
        resolver: PublicKeyResolver,
    ): TicketVerifyResult {
        if (parsed.eventId != expectedEventId.lowercase()) {
            return TicketVerifyResult.Invalid(TicketInvalidReason.WRONG_EVENT)
        }
        val key = resolver.resolve(parsed.eventId, parsed.keyId)
        if (key == null || key.size != 32) {
            return TicketVerifyResult.Invalid(TicketInvalidReason.UNKNOWN_KEY)
        }
        val valid = try {
            signatureValid(key, parsed.signingInput.toByteArray(Charsets.UTF_8), parsed.signature)
        } catch (_: RuntimeException) {
            false
        }
        if (!valid) return TicketVerifyResult.Invalid(TicketInvalidReason.BAD_SIGNATURE)
        return TicketVerifyResult.Valid(
            TicketFields(parsed.keyId, parsed.eventId, parsed.ticketId, parsed.seatInfo),
        )
    }

    private fun signatureValid(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        // BouncyCastle also rejects S >= L, but the spec asks us to check it explicitly.
        val s = BigInteger(1, signature.copyOfRange(32, 64).reversedArray())
        if (s >= GROUP_ORDER) return false
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }

    private fun decodeStrictUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        null
    }

    internal fun bytesToUuid(bytes: ByteArray): String {
        val hex = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-" +
            "${hex.substring(16, 20)}-${hex.substring(20)}"
    }
}

/** Fields carried by a payload (all authenticated by the signature). */
data class TicketFields(
    val keyId: String,
    val eventId: String,
    val ticketId: String,
    val seatInfo: String,
)

class ParsedTicketPayload(
    val keyId: String,
    val eventId: String,
    val ticketId: String,
    val seatInfo: String,
    /** Exact signed text (its UTF-8 bytes are the Ed25519 message). */
    val signingInput: String,
    val signature: ByteArray,
)

/** Raw 32-byte Ed25519 public key, or null when the key is unknown or revoked. */
fun interface PublicKeyResolver {
    fun resolve(eventId: String, keyId: String): ByteArray?
}

enum class TicketInvalidReason { MALFORMED, WRONG_EVENT, UNKNOWN_KEY, BAD_SIGNATURE }

sealed interface TicketVerifyResult {
    data class Valid(val ticket: TicketFields) : TicketVerifyResult
    data class Invalid(val reason: TicketInvalidReason) : TicketVerifyResult
}
