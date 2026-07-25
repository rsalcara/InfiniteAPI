package com.rsalcara.infiniteapi.attestation

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec

data class AttestationSnapshot(
	val keyAttestationBase64: String,
	val gpiaBase64: String,
	val clientAppId: String,
	val packageName: String,
	val generatedAtMs: Long,
	val expiresAtMs: Long
)

class AttestationRepository(private val context: Context) {
	private val preferences = context.getSharedPreferences("attestation", Context.MODE_PRIVATE)
	private val secureRandom = SecureRandom()

	@Synchronized
	fun current(clientAppId: String): AttestationSnapshot {
		check(
			clientAppId == BuildConfig.WABA_CLIENT_APP_ID ||
				clientAppId == BuildConfig.WA_MESSENGER_CLIENT_APP_ID
		) { "Unsupported client-app-id" }

		val now = System.currentTimeMillis()
		val preferenceSuffix = clientAppId
		var alias = preferences.getString("alias_$preferenceSuffix", null)
		var generatedAtMs = preferences.getLong("generated_at_ms_$preferenceSuffix", 0L)
		val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
		if (
			alias == null ||
			generatedAtMs <= 0L ||
			now - generatedAtMs >= BuildConfig.ATTESTATION_TTL_MS ||
			!keyStore.containsAlias(alias)
		) {
			alias?.let { if (keyStore.containsAlias(it)) keyStore.deleteEntry(it) }
			alias = "infiniteapi_attestation_${clientAppId}_$now"
			generateAttestedKey(alias)
			generatedAtMs = now
			preferences
				.edit()
				.putString("alias_$preferenceSuffix", alias)
				.putLong("generated_at_ms_$preferenceSuffix", generatedAtMs)
				.commit()
			keyStore.load(null)
		}

		val chain = checkNotNull(keyStore.getCertificateChain(alias)) {
			"Android Keystore returned no attestation certificate chain"
		}
		check(chain.isNotEmpty()) { "Android Keystore returned an empty attestation certificate chain" }

		// Android returns leaf-first; WABA serializes root → intermediate → leaf.
		val rootFirstDer = chain.reversed().flatMap { it.encoded.asIterable() }.toByteArray()
		return AttestationSnapshot(
			keyAttestationBase64 = Base64.encodeToString(rootFirstDer, Base64.NO_WRAP),
			gpiaBase64 = "",
			clientAppId = clientAppId,
			packageName = BuildConfig.APPLICATION_ID,
			generatedAtMs = generatedAtMs,
			expiresAtMs = generatedAtMs + BuildConfig.ATTESTATION_TTL_MS
		)
	}

	private fun generateAttestedKey(alias: String) {
		val challenge = ByteBuffer.allocate(41).putInt(0).apply {
			val randomPart = ByteArray(37)
			secureRandom.nextBytes(randomPart)
			put(randomPart)
		}.array()

		val specification = KeyGenParameterSpec.Builder(
			alias,
			KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
		)
			.setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
			.setDigests(KeyProperties.DIGEST_SHA256)
			.setAttestationChallenge(challenge)
			.setUserAuthenticationRequired(false)
			.build()

		KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
			initialize(specification)
			generateKeyPair()
		}
	}
}
