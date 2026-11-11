package org.tix.checkin.update

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpHeaders
import org.tix.checkin.core.GithubHosts

/** A GitHub URL (or a redirect target) outside the allow-list, over http, or too many redirects. */
class GithubUrlRefusedException(val url: String) : IllegalStateException("GitHub URL refused: $url")

private val REDIRECT_STATUS = setOf(301, 302, 303, 307, 308)

private class Box<T>(val value: T)

/**
 * GET [url] with [client] (see `TixHttpClient.createGithub`: no device token, no automatic redirects) and follow
 * redirects by hand: https only, GitHub host allow-list, at most [GithubHosts.MAX_REDIRECTS] hops. [block] sees the
 * final non-redirect response while it is still open (streaming).
 */
suspend fun <T> HttpClient.githubGet(
    url: String,
    headers: Map<String, String> = emptyMap(),
    longRunning: Boolean = false,
    block: suspend (HttpResponse) -> T,
): T {
    var current = url
    var hop = 0
    while (true) {
        if (!GithubHosts.isAllowedUrl(current)) throw GithubUrlRefusedException(current)
        var next: String? = null
        val at = current
        val boxed = prepareGet(at) {
            headers.forEach { (k, v) -> header(k, v) }
            if (longRunning) timeout { requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS }
        }.execute { response ->
            if (response.status.value in REDIRECT_STATUS) {
                next = GithubHosts.redirectTarget(at, response.headers[HttpHeaders.Location].orEmpty(), hop)
                    ?: throw GithubUrlRefusedException(response.headers[HttpHeaders.Location].orEmpty())
                null
            } else {
                Box(block(response))
            }
        }
        if (boxed != null) return boxed.value
        current = next!!
        hop++
    }
}
