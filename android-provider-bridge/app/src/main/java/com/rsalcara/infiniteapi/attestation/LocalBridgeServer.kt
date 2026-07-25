package com.rsalcara.infiniteapi.attestation

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.io.Closeable
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.concurrent.Executors

class LocalBridgeServer(
	private val context: Context,
	private val repository: AttestationRepository
) : Closeable {
	companion object {
		const val PORT = 8789
	}

	private val executor = Executors.newCachedThreadPool()
	@Volatile private var serverSocket: ServerSocket? = null

	fun start() {
		if (serverSocket != null) return
		serverSocket = ServerSocket(PORT, 16, InetAddress.getLoopbackAddress())
		executor.execute {
			while (!Thread.currentThread().isInterrupted) {
				val socket = try {
					serverSocket?.accept() ?: break
				} catch (_: Exception) {
					break
				}
				executor.execute { socket.use(::handle) }
			}
		}
	}

	private fun handle(socket: Socket) {
		socket.soTimeout = 5_000
		val reader = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
		val requestLine = reader.readLine() ?: return
		val requestParts = requestLine.split(' ')
		if (requestParts.size < 2) return respond(socket, 400, errorJson("malformed-request"))

		val headers = mutableMapOf<String, String>()
		while (true) {
			val line = reader.readLine() ?: break
			if (line.isEmpty()) break
			val separator = line.indexOf(':')
			if (separator > 0) {
				headers[line.substring(0, separator).trim().lowercase()] = line.substring(separator + 1).trim()
			}
		}

		if (!authorized(headers["authorization"])) {
			return respond(socket, 401, errorJson("unauthorized"))
		}

		val method = requestParts[0]
		val path = requestParts[1]
		when {
			method == "GET" && path == "/health" -> {
				respond(
					socket,
					200,
					JSONObject()
						.put("ok", true)
						.put("configured", BuildConfig.CLIENT_APP_ID.isNotBlank())
						.put("packageName", context.packageName)
						.toString()
				)
			}
			method == "POST" && path == "/v1/attestation" -> {
				try {
					val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
					check(contentLength in 1..16_384) { "invalid-content-length" }
					val bodyChars = CharArray(contentLength)
					var offset = 0
					while (offset < contentLength) {
						val count = reader.read(bodyChars, offset, contentLength - offset)
						check(count > 0) { "incomplete-request-body" }
						offset += count
					}
					val request = JSONObject(String(bodyChars))
					val appVariant = request.optString("appVariant")
					val clientAppId = request.optString("clientAppId")
					val targetPackageName = request.optString("packageName")
					val expectedClientAppId = when (appVariant) {
						"business" -> BuildConfig.WABA_CLIENT_APP_ID
						"consumer" -> BuildConfig.WA_MESSENGER_CLIENT_APP_ID
						else -> error("unsupported-app-variant")
					}
					val expectedPackageName = when (appVariant) {
						"business" -> "com.whatsapp.w4b"
						"consumer" -> "com.whatsapp"
						else -> error("unsupported-app-variant")
					}
					check(clientAppId == expectedClientAppId) { "client-app-id-mismatch" }
					check(targetPackageName == expectedPackageName) { "target-package-mismatch" }

					val snapshot = repository.current(clientAppId)
					respond(
						socket,
						200,
						JSONObject()
							.put("keyAttestationBase64", snapshot.keyAttestationBase64)
							.put("gpiaBase64", snapshot.gpiaBase64)
							.put("clientAppId", snapshot.clientAppId)
							.put("packageName", snapshot.packageName)
							.put("appVariant", appVariant)
							.put("targetPackageName", targetPackageName)
							.put("generatedAtMs", snapshot.generatedAtMs)
							.put("expiresAtMs", snapshot.expiresAtMs)
							.toString()
					)
				} catch (error: Exception) {
					respond(socket, 503, errorJson(error.message ?: "attestation-unavailable"))
				}
			}
			else -> respond(socket, 404, errorJson("not-found"))
		}
	}

	private fun authorized(header: String?): Boolean {
		if (BuildConfig.PROVIDER_TOKEN.isEmpty()) return true
		val expected = "Bearer ${BuildConfig.PROVIDER_TOKEN}".toByteArray(StandardCharsets.UTF_8)
		val received = (header ?: "").toByteArray(StandardCharsets.UTF_8)
		return MessageDigest.isEqual(expected, received)
	}

	private fun errorJson(reason: String) = JSONObject().put("ok", false).put("reason", reason).toString()

	private fun respond(socket: Socket, status: Int, body: String) {
		val reason = when (status) {
			200 -> "OK"
			400 -> "Bad Request"
			401 -> "Unauthorized"
			404 -> "Not Found"
			else -> "Service Unavailable"
		}
		val bytes = body.toByteArray(StandardCharsets.UTF_8)
		socket.getOutputStream().apply {
			write(
				(
					"HTTP/1.1 $status $reason\r\n" +
						"Content-Type: application/json\r\n" +
						"Content-Length: ${bytes.size}\r\n" +
						"Connection: close\r\n\r\n"
				).toByteArray(StandardCharsets.US_ASCII)
			)
			write(bytes)
			flush()
		}
	}

	override fun close() {
		serverSocket?.close()
		serverSocket = null
		executor.shutdownNow()
	}
}
