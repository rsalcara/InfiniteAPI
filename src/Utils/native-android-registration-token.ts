import { createHmac, pbkdf2Sync } from 'node:crypto'

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
