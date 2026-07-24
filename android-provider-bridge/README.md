# InfiniteAPI Android Attestation Provider

Experimental companion for `transportProfile: 'native_android'`.

It generates an EC key inside Android Keystore, requests the platform's genuine
certificate chain, keeps the private key inside Android, and exposes only the
current public attestation artifacts on Android loopback.

This module intentionally uses its own package and signing identity:
`com.rsalcara.infiniteapi.attestation`. It does not claim to be WhatsApp and
does not reuse the certificate captured from `com.whatsapp.w4b`.

## Build

An authorized numeric client application id must be supplied at build time:

```powershell
.\gradlew.bat :app:assembleDebug `
  -PINFINITEAPI_ANDROID_CLIENT_APP_ID=YOUR_AUTHORIZED_ID `
  -PINFINITEAPI_ANDROID_PROVIDER_TOKEN=YOUR_LOCAL_TOKEN
```

Without `INFINITEAPI_ANDROID_CLIENT_APP_ID`, the APK still builds but its
attestation endpoint returns `503`; this prevents an accidental test with a
fabricated identity.

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
```

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
