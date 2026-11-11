package org.tix.checkin.net

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.serialization.kotlinx.json.json
import io.ktor.client.plugins.HttpTimeout
import kotlinx.serialization.json.Json
import org.tix.checkin.core.contract.ScannerJson
import org.tix.checkin.core.ServerUrlPolicy

/** Thrown before any bytes are sent when [ServerUrlPolicy] refuses the target URL. */
class ServerUrlRefusedException(val url: String, val reason: ServerUrlPolicy.Reason) :
    IllegalStateException("Server URL refused ($reason): $url")

/**
 * Enforces [ServerUrlPolicy] on every request: https anywhere, http only to local-network hosts.
 * Install it AFTER `defaultRequest { ... }` (if used) so the final, resolved URL is checked.
 */
val ServerUrlGuard = createClientPlugin("TixServerUrlGuard") {
    onRequest { request, _ ->
        val url = request.url.buildString()
        val decision = ServerUrlPolicy.check(url)
        if (decision is ServerUrlPolicy.Decision.Refused) {
            throw ServerUrlRefusedException(url, decision.reason)
        }
    }
}

object TixHttpClient {
    /** The shared contract JSON (explicitNulls = false, see :core ScannerJson). */
    val json: Json = ScannerJson

    /**
     * The single place where HTTP clients are created. Redirects are NOT followed: a redirect
     * could otherwise bounce a request from an https/local server to an arbitrary host.
     */
    fun create(): HttpClient = HttpClient(OkHttp) {
        followRedirects = false
        expectSuccess = false
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            connectTimeoutMillis = 8_000
            requestTimeoutMillis = 30_000
            socketTimeoutMillis = 30_000
        }
        install(ServerUrlGuard)
    }
}
