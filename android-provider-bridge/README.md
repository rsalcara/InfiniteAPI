# InfiniteAPI Android Attestation Provider

Experimental companion for `transportProfile: 'native_android'`.

It generates an EC key inside Android Keystore, requests the platform's genuine
certificate chain, keeps the private key inside Android, and exposes only the
current public attestation artifacts on Android loopback.

This module intentionally uses its own package and signing identity:
`com.rsalcara.infiniteapi.attestation`. It does not claim to be WhatsApp and
does not reuse the certificate captured from `com.whatsapp.w4b`.

## Build

The independently audited Business and Messenger client application
identifiers are built in. The requested variant is validated against an exact
allow-list before the provider returns an artifact. Only the local bridge token
must be supplied:

```powershell
.\gradlew.bat :app:assembleDebug `
  -PINFINITEAPI_ANDROID_PROVIDER_TOKEN=YOUR_LOCAL_TOKEN
```

The values are application-wide. They are not derived from the hardware
catalog and do not change with the selected model or session:

- `business` / `com.whatsapp.w4b`: `473039703209605`
- `consumer` / `com.whatsapp`: `994766073959253`

### Origin and maintenance of `client-app-id`

This identifier is part of the official WhatsApp Business APK. During native
companion registration, the application places it in the `client-app-id` child
of the `pair-device-sign` stanza. InfiniteAPI keeps the same application-wide
value; it must not be generated from the chosen Samsung/Motorola profile,
`phoneId`, `deviceExpId` or the current session.

The value was independently located and decoded in the following WABA builds:

- 2.26.19.11
- 2.26.25.4
- 2.26.27.83
- 2.26.28.3
- 2.26.28.5

The obfuscated Java class name changed between builds, but the decoded
identifier remained `473039703209605`.

The regular WhatsApp Messenger APK (`com.whatsapp`) was checked separately.
Although it contains `473039703209605` in shared application-ID lists, its
equivalent `A0F` pairing constant is `994766073959253`. Therefore the two
variants must not be inferred from a raw literal search or share one constant.
The bridge accepts both identities, but never chooses between them. InfiniteAPI
passes the variant confirmed by the server's `pair-success/platform` node and
the bridge rejects an inconsistent variant, package or client ID.

This is a maintained protocol constant, not an assumption that it will remain
unchanged forever. Every official APK upgrade used by `native_android` must run
the APKM verification script. If a future APK changes either identifier, update
`NATIVE_ANDROID_APP_IDENTITIES`, this provider's `BuildConfig` values and all
related tests in the same change. The current audit script and evidence are
stored in:

```text
C:\github\WABA-ANDROID-RE\Analise de Estudos\read-client-app-id.ps1
C:\github\WABA-ANDROID-RE\Analise de Estudos\_client_app_id_analysis
```

## Install and expose to the host

```powershell
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.rsalcara.infiniteapi.attestation/.MainActivity
adb forward tcp:8789 tcp:8789
```

The bridge binds only to Android `127.0.0.1`. `adb forward` makes that loopback
port available to the host for a controlled test.

## InfiniteAPI test profile

```env
INFINITEAPI_TRANSPORT=native_android
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
INFINITEAPI_ANDROID_PROVIDER_URL=http://127.0.0.1:8789
INFINITEAPI_ANDROID_PROVIDER_TOKEN=YOUR_LOCAL_TOKEN
INFINITEAPI_ANDROID_PROVIDER_PACKAGE=com.rsalcara.infiniteapi.attestation
NATIVE_ANDROID_APP_VARIANT=auto
```

In automatic mode, `smba`/`smbi` selects Business and
`android`/`iphone` selects Messenger before `pair-device-sign` is sent. Unknown
or missing platform values fail closed. A registered session always reuses its
persisted concrete variant and cannot be changed by this setting.

The application identity is already present in the pre-QR `ClientPayload`.
Consequently, if the scanner rejects that advertised application before the
server emits `pair-success`, the same QR cannot be changed in place. The caller
must start a fresh, still-unregistered attempt with the alternative variant.

The established modes remain available:

```env
INFINITEAPI_TRANSPORT=web
INFINITEAPI_AUTH_STORAGE=json
```

```env
INFINITEAPI_TRANSPORT=web
INFINITEAPI_AUTH_STORAGE=sqlite
```

```env
INFINITEAPI_TRANSPORT=web
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
```

The environment resolver applies only to new-session orchestration. Persisted
Web and native-Android sessions are never converted automatically.

## Security and lifecycle

- Android returns certificate chains leaf-first; the provider serializes them
  root-first to match the captured WABA `key_attestation`.
- The provider rotates its test key after ten minutes.
- InfiniteAPI rejects stale, malformed, empty or wrong-package responses.
- No private key, captured WABA chain, `phoneId`, or provider response is
  written to JSON, monolithic SQLite, or multi-DB SQLite auth state.
- A provider failure never silently falls back to Web.

Server acceptance of this independently signed Android identity is the purpose
of the experiment. A rejection demonstrates that official provisioning is
required; it must not be bypassed by copying the official package identity.
