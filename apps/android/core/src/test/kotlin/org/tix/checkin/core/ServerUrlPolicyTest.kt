package org.tix.checkin.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ServerUrlPolicyTest {
    @Test
    fun `https is allowed for any host`() {
        assertTrue(ServerUrlPolicy.isAllowed("https://tickets.example.org"))
        assertTrue(ServerUrlPolicy.isAllowed("https://tickets.example.org:8443/api"))
        assertTrue(ServerUrlPolicy.isAllowed("HTTPS://8.8.8.8"))
    }

    @Test
    fun `http is allowed for local hosts`() {
        listOf(
            "http://10.0.0.1",
            "http://10.0.2.2:8080",
            "http://172.16.0.1",
            "http://172.31.255.254",
            "http://192.168.1.20:8080/x",
            "http://169.254.10.10",
            "http://127.0.0.1:3000",
            "http://localhost:8080",
            "http://LOCALHOST",
            "http://box-office.local",
            "http://box-office.local.:8080",
            "http://[::1]:8080",
            "http://[fe80::1%25wlan0]:8080",
        ).forEach { assertTrue(ServerUrlPolicy.isAllowed(it), it) }
    }

    @Test
    fun `http is refused for public hosts`() {
        listOf(
            "http://example.org",
            "http://8.8.8.8",
            "http://172.15.0.1",
            "http://172.32.0.1",
            "http://192.169.0.1",
            "http://11.0.0.1",
            "http://192.168.1.5.example.com", // a name, not an address
            "http://10.0.0.1.evil.org",
            "http://local", // not an mDNS name
            "http://evil.org.local.example.com",
            "http://[2001:db8::1]",
            "http://[fec0::1]",
            "http://192.168.1.256", // not an IPv4 address
        ).forEach { assertFalse(ServerUrlPolicy.isAllowed(it), it) }
    }

    @Test
    fun `refusal reasons`() {
        assertEquals(
            ServerUrlPolicy.Decision.Refused(ServerUrlPolicy.Reason.CLEARTEXT_NOT_LOCAL),
            ServerUrlPolicy.check("http://example.org"),
        )
        assertEquals(
            ServerUrlPolicy.Decision.Refused(ServerUrlPolicy.Reason.UNSUPPORTED_SCHEME),
            ServerUrlPolicy.check("ftp://192.168.1.1"),
        )
        assertEquals(
            ServerUrlPolicy.Decision.Refused(ServerUrlPolicy.Reason.USER_INFO),
            ServerUrlPolicy.check("http://192.168.1.1@evil.org"),
        )
        assertEquals(
            ServerUrlPolicy.Decision.Refused(ServerUrlPolicy.Reason.INVALID_URL),
            ServerUrlPolicy.check("not a url"),
        )
        assertEquals(
            ServerUrlPolicy.Decision.Refused(ServerUrlPolicy.Reason.INVALID_URL),
            ServerUrlPolicy.check("192.168.1.1:8080"),
        )
        assertEquals(
            ServerUrlPolicy.Decision.Refused(ServerUrlPolicy.Reason.INVALID_URL),
            ServerUrlPolicy.check(""),
        )
    }
}
