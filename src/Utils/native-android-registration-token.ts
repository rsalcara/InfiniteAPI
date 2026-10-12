import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import type { NativeAndroidAppVersion } from '../Types'
import { nativeAndroidRegistrationAppVersion } from './native-android-registration-device-attestation'

/**
 * Official classic registration `token` computation (W4B 2.26.36.72 class
 * `X.FDh` -> jadx `X/C34391FDh`, served as `AbstractC33390Emy.A00` and called
 * from `RequestCodeRepository` with the `$phoneNumber` value, i.e. the `in=`
 * national digits).
 *
 * Chain, 1:1 with the decompiled source (identical in both variants):
 * 1. password bytes = UTF-8(packageName) || about_logo.png bytes, in that order
 *    (the APK writes the package name into a ByteArrayOutputStream first, then
 *    copies the resolved `about_logo.png` drawable resource into it).
 * 2. `PBKDF2WithHmacSHA1And8BIT(salt, chars, 128, 512)` via
 *    `SecretKeyFactory.generateSecret(PBEKeySpec(password, salt, 128, 512))`:
 *    128 iterations and a 512-bit (64-byte) derived key. The "And8BIT" factory
 *    consumes each password byte as one char, so Node's PBKDF2 over the raw
 *    buffer is byte-identical to the APK's char[] stream.
 * 3. HMAC-SHA1 over: first signing certificate DER bytes || raw 16-byte MD5 of
 *    the `classes.dex` zip entry || UTF-8(`in=` digits).
 * 4. Output = `Base64.encodeToString(hmac, 2)`, android.util.Base64 flag 2
 *    (`NO_WRAP`): standard alphabet, padding kept.
 *
 * Variant sources verified 1:1:
 * - business: W4B 2.26.36.72 `X.FDh` -> `X/C34391FDh`.
 * - consumer: Messenger 2.26.37.6 `X/C34840FUs` and 2.26.38.10 `X/C39898Hdz`
 *   (same chain; salt constant in `X/AbstractC34151F0n.A00` / `X/H8T.A00`),
 *   cert from `X/C35521hO.A08` / `X/C1KB.A08`.
 *
 * Logo resolution is 1:1 with the APK (consumer `X/C39898Hdz`, W4B `X.FDh`):
 * try the classpath resources `/res/drawable-hdpi/about_logo.png`,
 * `/res/drawable-hdpi-v4/about_logo.png`, `/res/drawable-xxhdpi-v4/about_logo.png`
 * in that order, and only if all are missing fall back to
 * `Resources.openRawResource(R.drawable.about_logo)` on a DisplayMetrics forced
 * to 240dpi. Extractors walk the same order against the installed split APKs; a
 * given install may carry several buckets (2.26.38.10 ships hdpi-v4 and
 * xxhdpi-v4 inside `split_config.xhdpi.apk`).
 *
 * Wire-verified bucket (2026-10-12): the token the live server accepts is the
 * one computed over the XXHDPI asset — W4B 2.26.36.72 and 2.26.39.72 ship the
 * SAME 32006-byte `drawable-xxhdpi-v4/about_logo.png` (sha256 bcf87af0…) and
 * the hdpi-v4 pick (12170 B, 150×150 vs 300×300) answers `bad_token`. The
 * classpath order above walks hdpi first, but the server-side expectation
 * follows the xxhdpi bucket — extract the xxhdpi variant.
 *
 * `signingCertDer` is the OLDEST certificate of the signing lineage, not the
 * current signer: on SDK 28+ the chain takes
 * `SigningInfo.getSigningCertificateHistory()[0]`, so a key-rotated install
 * (2.26.38.10 signs with "WhatsApp LLC" but keeps "Brian Acton" as history[0])
 * still hashes the legacy cert.
 *
 * Verified byte-for-byte against a captured real `/v2/code` request
 * (`token=hEjVbznrgA3o2tS3JoE4vuRVxVg=` for `in=1531997072`); the test suite
 * pins that wire vector with the exact capture-time APK material.
 */

/** Official PBKDF2 salt (`AbstractC33391Emz.A00` / `X/H8T.A00`), identical across builds. */
export const NATIVE_ANDROID_REGISTRATION_TOKEN_SALT_BASE64 =
	'PkTwKSZqUfAUyR0rPQ8hYJ0wNsQQ3dW1+3SCnyTXIfEAxxS75FwkDf47wNv/c8pP3p0GXKR6OOQmhyERwx74fw1RYSU10I4r1gyBVDbRJ40pidjM41G1I1oN'

/** Official package names whose bytes prefix the PBKDF2 password. */
export const NATIVE_ANDROID_REGISTRATION_PACKAGES = {
	business: 'com.whatsapp.w4b',
	consumer: 'com.whatsapp'
} as const

/**
 * Byte material read from the installed APK. Every field is resolved exactly
 * as the APK does at runtime; nothing here is derivable from protocol state,
 * so callers extract it once per installed build (the logo is whatever
 * resource the device's density bucket resolves for `about_logo.png`).
 */
export type NativeAndroidRegistrationTokenMaterial = {
	/** `context.getPackageName()`; see `NATIVE_ANDROID_REGISTRATION_PACKAGES`. */
	packageName: string
	/** Raw bytes of the resolved `about_logo.png` drawable resource. */
	logoResource: Uint8Array
	/** DER bytes of the first signing certificate (`Signature[0].toByteArray()`). */
	signingCertDer: Uint8Array
	/** Raw 16-byte MD5 digest of the `classes.dex` entry of the base APK. */
	classesDexMd5: Uint8Array
	/**
	 * Build manifest pinning this material to its source APK (audit gap A).
	 * When present the token computation fail-closes on any blob/variant/version
	 * mismatch and the flow announces `manifest.version` (User-Agent and creds
	 * `appVersion`), so the wire always names the build whose material signs
	 * the token.
	 */
	manifest?: NativeAndroidRegistrationMaterialManifest
}

/**
 * `manifest.json`, stored next to the extracted blobs. Material without it
 * carries no version: a logo/cert/dex swapped from another build would still
 * announce the pinned User-Agent and the server would see a token signed over
 * material that does not belong to the announced client (`bad_token`). The
 * hashes cover the exact bytes the token computation consumes — for
 * `classesDexMd5` that is the raw 16-byte digest, not the hex file on disk.
 */
export type NativeAndroidRegistrationMaterialManifest = {
	/** Variant the blobs were extracted from; must match the registration variant. */
	appVariant: 'business' | 'consumer'
	/** `context.getPackageName()` of that build; see `NATIVE_ANDROID_REGISTRATION_PACKAGES`. */
	packageName: string
	/** Official `versionName` of that build (4 components), e.g. `2.26.36.72`. */
	version: string
	/** sha-256 (hex, lowercase) of each extracted blob. */
	hashes: {
		logoResource: string
		signingCertDer: string
		classesDexMd5: string
	}
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

/** sha-256 manifest hashes of the exact bytes the token computation consumes. */
export const computeMaterialManifestHashes = (
	material: NativeAndroidRegistrationTokenMaterial
): NativeAndroidRegistrationMaterialManifest['hashes'] => ({
	logoResource: sha256Hex(material.logoResource),
	signingCertDer: sha256Hex(material.signingCertDer),
	classesDexMd5: sha256Hex(material.classesDexMd5)
})

/**
 * Single sha-256 correlation digest naming the exact APK token material
 * (audit gap F): the digest over the three manifest hash digests. One value in
 * the sanitized log instead of per-blob hashes, and no material bytes ever
 * leave the process. Computed from the material itself, so a flow without
 * `manifest.json` still logs a material identity; with a manifest, the logged
 * digest matches the one derived from `manifest.hashes`.
 */
export const computeRegistrationMaterialHash = (material: NativeAndroidRegistrationTokenMaterial): string => {
	const hashes = computeMaterialManifestHashes(material)
	return createHash('sha256')
		.update(`${hashes.logoResource}|${hashes.signingCertDer}|${hashes.classesDexMd5}`, 'utf8')
		.digest('hex')
}

const MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * Validates a parsed `manifest.json` (shape only — the caller still pins the
 * hashes against the material via `validateMaterialManifest`). Fails closed on
 * any field that does not match the documented shape.
 */
export const parseMaterialManifest = (raw: unknown): NativeAndroidRegistrationMaterialManifest => {
	// Explicit `() => never` annotation so every `invalid()` call narrows the
	// remaining control flow (TS only applies never-call analysis to callees
	// with an explicit type annotation).
	const invalid: () => never = (): never => {
		throw new Error('native_android registration manifest: invalid manifest.json shape')
	}
	if (typeof raw !== 'object' || raw === null) invalid()
	const source = raw as Record<string, unknown>
	const appVariant = source.appVariant
	if (appVariant !== 'business' && appVariant !== 'consumer') invalid()
	const packageName = source.packageName
	if (typeof packageName !== 'string' || !packageName) invalid()
	const version = source.version
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) invalid()
	const hashes = source.hashes
	if (typeof hashes !== 'object' || hashes === null) invalid()
	const hashRecord = hashes as Record<string, unknown>
	const readHash = (field: 'logoResource' | 'signingCertDer' | 'classesDexMd5'): string => {
		const value = hashRecord[field]
		if (typeof value !== 'string' || !MANIFEST_HASH_PATTERN.test(value)) invalid()
		return value
	}
	return {
		appVariant,
		packageName,
		version,
		hashes: {
			logoResource: readHash('logoResource'),
			signingCertDer: readHash('signingCertDer'),
			classesDexMd5: readHash('classesDexMd5')
		}
	}
}

/**
 * `manifest.version` as the 4-tuple every UA/creds field carries. Parsing is
 * strict decimal `x.y.z.w`; `validateMaterialManifest` has already pinned the
 * value to the authorized build for the variant.
 */
export const materialManifestAppVersion = (
	manifest: NativeAndroidRegistrationMaterialManifest
): NativeAndroidAppVersion => {
	const parts = manifest.version.split('.').map(part => Number.parseInt(part, 10))
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0)) {
		throw new Error('native_android registration manifest: version must be the 4-part versionName')
	}
	return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

/**
 * Pins the manifest to the material actually configured: variant, package,
 * authorized build and blob hashes must all agree. `expectedAppVariant` (the
 * registration variant) must match the manifest when given — material from the
 * other variant must never sign this flow's token.
 */
export const validateMaterialManifest = (
	manifest: NativeAndroidRegistrationMaterialManifest,
	material: NativeAndroidRegistrationTokenMaterial,
	expectedAppVariant?: 'business' | 'consumer'
): void => {
	if (expectedAppVariant && manifest.appVariant !== expectedAppVariant) {
		throw new Error('native_android registration manifest: appVariant does not match the registration variant')
	}

	const expectedPackage = NATIVE_ANDROID_REGISTRATION_PACKAGES[manifest.appVariant]
	if (manifest.packageName !== expectedPackage) {
		throw new Error('native_android registration manifest: packageName does not match the manifest appVariant')
	}

	if (material.packageName !== manifest.packageName) {
		throw new Error('native_android registration manifest: packageName does not match the material')
	}

	// The manifest must name the build the variant is authorized to announce:
	// a version pin that diverges from `nativeAndroidRegistrationAppVersion`
	// would describe a client build the token was not extracted from.
	if (manifest.version !== nativeAndroidRegistrationAppVersion(manifest.appVariant).join('.')) {
		throw new Error('native_android registration manifest: version is not the authorized build for the variant')
	}

	const expected = computeMaterialManifestHashes(material)
	for (const field of ['logoResource', 'signingCertDer', 'classesDexMd5'] as const) {
		if (manifest.hashes[field] !== expected[field]) {
			throw new Error(`native_android registration manifest: hashes.${field} does not match the material`)
		}
	}
}

const validateMaterial = (material: NativeAndroidRegistrationTokenMaterial) => {
	if (!material.packageName) throw new Error('native_android registration token: packageName is required')
	if (!material.logoResource.length) {
		throw new Error('native_android registration token: logoResource is required')
	}

	if (!material.signingCertDer.length) {
		throw new Error('native_android registration token: signingCertDer is required')
	}

	if (material.classesDexMd5.length !== 16) {
		throw new Error('native_android registration token: classesDexMd5 must be the raw 16-byte MD5 digest')
	}

	// Material with a manifest must pin it to the blobs actually configured —
	// the version announced on the wire derives from `manifest.version`.
	if (material.manifest) {
		validateMaterialManifest(material.manifest, material)
	}
}

/**
 * Computes the official classic registration `token` for one request.
 *
 * `nationalNumber` is the exact `in=` value (national digits, no country code
 * and no formatting) — the same string the builder puts in the query, because
 * the APK signs `$phoneNumber` which becomes `in=`.
 */
export const buildClassicRegistrationToken = (
	nationalNumber: string,
	material: NativeAndroidRegistrationTokenMaterial
): string => {
	if (!nationalNumber || !/^\d{8,15}$/.test(nationalNumber)) {
		throw new Error('native_android registration token: nationalNumber must be the plain `in=` digits')
	}

	validateMaterial(material)

	const password = Buffer.concat([Buffer.from(material.packageName, 'utf8'), Buffer.from(material.logoResource)])
	const key = pbkdf2Sync(
		password,
		Buffer.from(NATIVE_ANDROID_REGISTRATION_TOKEN_SALT_BASE64, 'base64'),
		128,
		64,
		'sha1'
	)
	const mac = createHmac('sha1', key)
	mac.update(Buffer.from(material.signingCertDer))
	mac.update(Buffer.from(material.classesDexMd5))
	mac.update(Buffer.from(nationalNumber, 'utf8'))
	return mac.digest('base64')
}

/**
 * Binds fixed APK material once so the flow can request tokens per number
 * without re-validating the material on every call.
 */
export const createClassicRegistrationTokenBuilder = (
	material: NativeAndroidRegistrationTokenMaterial
): ((nationalNumber: string) => string) => {
	validateMaterial(material)
	return nationalNumber => buildClassicRegistrationToken(nationalNumber, material)
}
