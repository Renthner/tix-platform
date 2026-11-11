package org.tix.checkin.net

import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import org.tix.checkin.core.contract.ApiError
import org.tix.checkin.core.contract.ApiException
import org.tix.checkin.core.contract.AppLatest
import org.tix.checkin.core.contract.LookupResponse
import org.tix.checkin.core.contract.Manifest
import org.tix.checkin.core.contract.ManifestResult
import org.tix.checkin.core.contract.NetworkException
import org.tix.checkin.core.contract.PairRequest
import org.tix.checkin.core.contract.PairResponse
import org.tix.checkin.core.contract.ScanBatchRequest
import org.tix.checkin.core.contract.ScanBatchResponse
import org.tix.checkin.core.contract.ScanOutcome
import org.tix.checkin.core.contract.ScanRequest
import org.tix.checkin.core.contract.ScannerApi
import org.tix.checkin.core.contract.ScannerJson
import org.tix.checkin.core.contract.TokenUnavailableException
import org.tix.checkin.core.contract.SyncPage

/** Server address + bearer token of the paired device. */
data class Session(val serverUrl: String, val token: String)

/**
 * Ktor implementation of the device API (docs/SCANNER.md). Every failure is mapped to
 * [ApiException] (server answered with an error) or [NetworkException] (no usable answer), so the
 * callers only deal with those two. The one exception: an undecodable `/scans/batch` answer is a
 * `SerializationException` (the uploader bisects the batch on it).
 */
class KtorScannerApi(
    private val client: HttpClient,
    private val session: suspend () -> Session?,
    private val appVersion: String,
) : ScannerApi {

    private suspend fun requireSession(): Session =
        session() ?: throw ApiException(401, "INVALID_TOKEN", "not paired")

    private fun url(base: String, path: String) = base.trimEnd('/') + "/api/scanner/v1/" + path

    private suspend inline fun <T> call(block: () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: ApiException) {
        throw e
    } catch (e: TokenUnavailableException) {
        throw e // not a network problem and never a revocation: callers keep the data and tell the operator
    } catch (e: SerializationException) {
        throw e
    } catch (e: IOException) {
        throw NetworkException(e.message ?: "I/O error", e)
    } catch (e: Exception) {
        // Ktor timeouts, refused server URLs, DNS errors ...
        throw NetworkException(e.message ?: e::class.simpleName.orEmpty(), e)
    }

    private fun HttpRequestBuilder.auth(token: String) {
        header(HttpHeaders.Authorization, "Bearer $token")
        header("X-Scanner-App-Version", appVersion)
    }

    private suspend fun HttpResponse.ensureOk() {
        if (status.value in 200..299) return
        val text = runCatching { bodyAsText() }.getOrDefault("")
        val err = runCatching { ScannerJson.decodeFromString<ApiError>(text) }.getOrNull()
        val retry = headers[HttpHeaders.RetryAfter]?.trim()?.toIntOrNull()
        throw ApiException(status.value, err?.error?.takeIf { it.isNotEmpty() }, err?.message ?: "HTTP ${status.value}", retry)
    }

    private suspend inline fun <reified T> HttpResponse.decode(): T {
        ensureOk()
        return try {
            ScannerJson.decodeFromString<T>(bodyAsText())
        } catch (e: SerializationException) {
            throw e
        } catch (e: IllegalArgumentException) {
            throw SerializationException(e.message, e)
        }
    }

    /** Wraps decode errors of non-batch endpoints: they mean "no usable answer". */
    private suspend inline fun <reified T> HttpResponse.decodeOrNetwork(): T = try {
        decode()
    } catch (e: SerializationException) {
        throw NetworkException("unreadable response: ${e.message}", e)
    }

    /** `POST /pair` (no auth). */
    suspend fun pair(serverUrl: String, request: PairRequest): PairResponse = call {
        val r = client.post(url(serverUrl, "pair")) {
            contentType(ContentType.Application.Json)
            setBody(ScannerJson.encodeToString(request))
        }
        r.decodeOrNetwork()
    }

    override suspend fun manifest(etag: String?): ManifestResult = call {
        val s = requireSession()
        val r = client.get(url(s.serverUrl, "manifest")) {
            auth(s.token)
            // The server's ETag header is the quoted body etag.
            if (!etag.isNullOrEmpty()) header(HttpHeaders.IfNoneMatch, "\"$etag\"")
        }
        if (r.status.value == 304) ManifestResult.NotModified else ManifestResult.Updated(r.decodeOrNetwork<Manifest>())
    }

    override suspend fun sync(eventId: String, cursor: String?, limit: Int): SyncPage = call {
        val s = requireSession()
        val r = client.get(url(s.serverUrl, "sync")) {
            auth(s.token)
            parameter("eventId", eventId)
            if (!cursor.isNullOrEmpty()) parameter("cursor", cursor)
            parameter("limit", limit)
        }
        r.decodeOrNetwork()
    }

    override suspend fun scan(request: ScanRequest): ScanOutcome = call {
        val s = requireSession()
        val r = client.post(url(s.serverUrl, "scan")) {
            auth(s.token)
            contentType(ContentType.Application.Json)
            setBody(ScannerJson.encodeToString(request))
        }
        r.decodeOrNetwork()
    }

    override suspend fun scanBatch(requests: List<ScanRequest>, sentAt: String): ScanBatchResponse = call {
        val s = requireSession()
        val r = client.post(url(s.serverUrl, "scans/batch")) {
            auth(s.token)
            contentType(ContentType.Application.Json)
            setBody(ScannerJson.encodeToString(ScanBatchRequest(requests, sentAt)))
        }
        r.decode()
    }

    override suspend fun lookup(eventId: String, query: String, limit: Int): LookupResponse = call {
        val s = requireSession()
        val r = client.get(url(s.serverUrl, "lookup")) {
            auth(s.token)
            parameter("eventId", eventId)
            parameter("q", query)
            parameter("limit", limit)
        }
        r.decodeOrNetwork()
    }

    override suspend fun latestApp(): AppLatest? = call {
        val s = requireSession()
        val r = client.get(url(s.serverUrl, "app/latest")) { auth(s.token) }
        if (r.status.value == 404) null else r.decodeOrNetwork<AppLatest>()
    }
}
