package org.tix.checkin.core

import java.math.BigInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

/** Port of packages/shared/test/tickets.test.ts. The vector is the one in docs/TICKETS.md. */
class TicketPayloadTest {
    private val seed = ByteArray(32) { it.toByte() }
    private val publicKey = "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
    private val eventId = "00000000-0000-4000-8000-000000000001"
    private val ticketId = "00000000-0000-4000-8000-000000000002"
    private val signingInput =
        "tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg.UGFya2V0dHxSNXwxMg"
    private val payload =
        "tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg.UGFya2V0dHxSNXwxMg." +
            "rtTDrMv6GaEmTIQMvUPkOC7LGLnEOSzp816oE6eIZdLaTuccet2SFH1H-UxDjs-uXuucamvw30cb6SeM4bMkBA"

    private fun keyOf(b64: String) = PublicKeyResolver { _, _ -> Base64Url.decode(b64) }
    private val vectorKey = keyOf(publicKey)

    private fun sign(message: String, withSeed: ByteArray = seed): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(withSeed, 0))
        val bytes = message.toByteArray(Charsets.UTF_8)
        signer.update(bytes, 0, bytes.size)
        return signer.generateSignature()
    }

    /** Test-only builder mirroring `buildTicketPayload`. */
    private fun build(
        keyId: String = "k1",
        event: String = eventId,
        ticket: String = ticketId,
        seatInfo: String = "Parkett|R5|12",
        withSeed: ByteArray = seed,
    ): String {
        fun uuid(u: String): String {
            val hex = u.replace("-", "")
            return Base64Url.encode(ByteArray(16) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() })
        }
        val input = "tix://v1/$keyId.${uuid(event)}.${uuid(ticket)}." +
            Base64Url.encode(seatInfo.toByteArray(Charsets.UTF_8))
        return "$input.${Base64Url.encode(sign(input, withSeed))}"
    }

    private fun verify(p: String, expected: String = eventId, r: PublicKeyResolver = vectorKey) =
        TicketPayload.verify(p, expected, r)

    private fun invalid(reason: TicketInvalidReason) = TicketVerifyResult.Invalid(reason)

    private fun mutate(index: Int, value: String): String {
        val parts = payload.removePrefix(TicketPayload.PREFIX).split('.')
        return TicketPayload.PREFIX + parts.mapIndexed { i, p -> if (i == index) value else p }.joinToString(".")
    }

    @Test
    fun `reproduces and verifies the fixed test vector`() {
        assertEquals(payload, build(), "Ed25519 is deterministic: our signer must match the vector")
        val result = verify(payload)
        assertEquals(
            TicketVerifyResult.Valid(TicketFields("k1", eventId, ticketId, "Parkett|R5|12")),
            result,
        )
    }

    @Test
    fun `parse round trip`() {
        val parsed = assertNotNull(TicketPayload.parse(payload))
        assertEquals("k1", parsed.keyId)
        assertEquals(eventId, parsed.eventId)
        assertEquals(ticketId, parsed.ticketId)
        assertEquals("Parkett|R5|12", parsed.seatInfo)
        assertEquals(signingInput, parsed.signingInput)
        assertEquals(64, parsed.signature.size)
    }

    @Test
    fun `detects tampering of every segment`() {
        val other = build(ticket = "00000000-0000-4000-8000-000000000003", seatInfo = "Parkett|R5|13")
        val otherParts = other.removePrefix(TicketPayload.PREFIX).split('.')
        // ticket id / seat info swapped in from a different, validly signed ticket
        for (i in listOf(2, 3)) {
            assertEquals(invalid(TicketInvalidReason.BAD_SIGNATURE), verify(mutate(i, otherParts[i])))
        }
        val seat = Base64Url.encode("Parkett|R5|13".toByteArray())
        assertEquals(invalid(TicketInvalidReason.BAD_SIGNATURE), verify(mutate(3, seat)))
        // tampered event segment: claims another event than the verifier's
        val forgedEventId = "01010101-0101-0101-0101-010101010101"
        val forged = mutate(1, Base64Url.encode(ByteArray(16) { 1 }))
        assertEquals(invalid(TicketInvalidReason.WRONG_EVENT), verify(forged))
        assertEquals(invalid(TicketInvalidReason.BAD_SIGNATURE), verify(forged, forgedEventId))
        // tampered signature
        val sig = payload.substringAfterLast('.')
        val flipped = (if (sig.startsWith("A")) "B" else "A") + sig.substring(1)
        assertEquals(invalid(TicketInvalidReason.BAD_SIGNATURE), verify(mutate(4, flipped)))
    }

    @Test
    fun `rejects wrong keys and unknown keys`() {
        val other = ByteArray(32) { (it + 100).toByte() }
        val otherPub = Ed25519PrivateKeyParameters(other, 0).generatePublicKey().encoded
        assertEquals(invalid(TicketInvalidReason.BAD_SIGNATURE), verify(payload, r = { _, _ -> otherPub }))
        assertEquals(invalid(TicketInvalidReason.UNKNOWN_KEY), verify(payload, r = { _, _ -> null }))
        assertEquals(
            invalid(TicketInvalidReason.UNKNOWN_KEY),
            verify(payload, r = { _, _ -> Base64Url.decode("AAAA") }),
        )
    }

    @Test
    fun `selects the verification key by key id and event`() {
        val oldSeed = ByteArray(32) { (it + 7).toByte() }
        val oldPub = Ed25519PrivateKeyParameters(oldSeed, 0).generatePublicKey().encoded
        val p = build(keyId = "oldKey01", withSeed = oldSeed)
        val keys = mutableMapOf("oldKey01" to oldPub)
        val resolver = PublicKeyResolver { ev, key -> if (ev == eventId) keys[key] else null }
        assertIs<TicketVerifyResult.Valid>(verify(p, r = resolver))
        keys.remove("oldKey01") // revoked: resolver returns nothing
        assertEquals(invalid(TicketInvalidReason.UNKNOWN_KEY), verify(p, r = resolver))
    }

    @Test
    fun `handles seat info with dots pipes and unicode`() {
        val seatInfo = "Balkon 1.0 / links|Reihe ä.1|12 ♿"
        val p = build(seatInfo = seatInfo)
        assertEquals(5, p.removePrefix(TicketPayload.PREFIX).split('.').size)
        val res = assertIs<TicketVerifyResult.Valid>(verify(p))
        assertEquals(seatInfo, res.ticket.seatInfo)
    }

    @Test
    fun `accepts empty seat info`() {
        val res = assertIs<TicketVerifyResult.Valid>(verify(build(seatInfo = "")))
        assertEquals("", res.ticket.seatInfo)
    }

    @Test
    fun `rejects malformed payloads`() {
        val bad = listOf(
            "",
            "tix://v2/" + payload.substring(9),
            "$payload.x",
            payload.replace("k1.", "."),
            payload.dropLast(1),
            payload.replace("UGFya2V0dHxSNXwxMg", "UGFya2V0dHxSNXwxMh"), // non-canonical trailing bits
            payload.replace("k1.", "k!1."), // bad key id characters
            payload.replace("k1.", "${"k".repeat(17)}."), // key id too long
            payload.replace("UGFya2V0dHxSNXwxMg", "UGFya2V0dHxSNXwxM+"), // standard alphabet
            payload.replace("UGFya2V0dHxSNXwxMg", "UGFya2V0dHxSNXwxMg=="), // padding
            "tix://v1/" + "a.".repeat(5) + "b".repeat(400), // too long
            TicketPayload.PREFIX + "k1.AAAA.AAAA.AAAA.AAAA",
        )
        for (p in bad) {
            assertNull(TicketPayload.parse(p), p)
            assertEquals(invalid(TicketInvalidReason.MALFORMED), verify(p), p)
        }
    }

    @Test
    fun `rejects invalid utf8 in seat info`() {
        // 0xff 0xfe is not UTF-8; build the payload by hand with a (bogus) signature.
        val input = "tix://v1/k1.AAAAAAAAQACAAAAAAAAAAQ.AAAAAAAAQACAAAAAAAAAAg." +
            Base64Url.encode(byteArrayOf(0xff.toByte(), 0xfe.toByte()))
        val p = "$input.${Base64Url.encode(ByteArray(64))}"
        assertNull(TicketPayload.parse(p))
    }

    @Test
    fun `rejects a ticket of another event before any key lookup`() {
        var lookups = 0
        val res = verify(payload, "00000000-0000-4000-8000-0000000000ff") { _, _ ->
            lookups++
            Base64Url.decode(publicKey)
        }
        assertEquals(invalid(TicketInvalidReason.WRONG_EVENT), res)
        assertEquals(0, lookups)
    }

    @Test
    fun `expected event id comparison is case insensitive`() {
        assertIs<TicketVerifyResult.Valid>(verify(payload, eventId.uppercase()))
    }

    @Test
    fun `rejects a malleated signature with S plus L`() {
        val parsed = assertNotNull(TicketPayload.parse(payload))
        val l = BigInteger("7237005577332262213973186563042994240857116359379907606001950938285454250989")
        val s = BigInteger(1, parsed.signature.copyOfRange(32, 64).reversedArray())
        val malleated = s.add(l)
        assertTrue(malleated.bitLength() <= 256, "S + L must still fit 32 bytes for this vector")
        val le = ByteArray(32)
        val be = malleated.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
        for (i in be.indices) le[i] = be[be.size - 1 - i]
        val sig = parsed.signature.copyOf(64)
        le.copyInto(sig, 32)
        val p = "${payload.substringBeforeLast('.')}.${Base64Url.encode(sig)}"
        assertEquals(invalid(TicketInvalidReason.BAD_SIGNATURE), verify(p))
    }

    @Test
    fun `ticket code helpers`() {
        assertEquals("ABCDEFGH10", TicketCode.normalize("abcde-fgh1o"))
        assertEquals("1100", TicketCode.normalize(" il 0o "))
        assertEquals("ABCDE-FGHJK", TicketCode.format("ABCDEFGHJK"))
        assertEquals("ABC", TicketCode.format("ABC"))
    }

    @Test
    fun `base64url decoder is strict`() {
        assertEquals(listOf<Byte>(1, 2, 3), Base64Url.decode("AQID")?.toList())
        assertNull(Base64Url.decode("AQID="))
        assertNull(Base64Url.decode("A+ID"))
        assertNull(Base64Url.decode("A"))
        assertEquals(0, Base64Url.decode("")?.size)
    }
}
