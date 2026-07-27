# Native Android Node attestation

The `native_android` transport is self-contained in InfiniteAPI. It does not
install an APK, start an emulator or call an Android bridge.

For a fresh QR pairing, the built-in Node provider creates the binary shape
used by the pairing reply:

1. a root X.509 certificate in DER;
2. a leaf X.509 certificate in DER;
3. both certificates concatenated root-first;
4. an empty `gpia`;
5. the application-specific 15-digit client app ID.

Business and Consumer use independent persisted chains:

| Variant | Package | Client app ID |
| --- | --- | --- |
| `business` | `com.whatsapp.w4b` | `473039703209605` |
| `consumer` | `com.whatsapp` | `994766073959253` |

The provider persists only the public chain, timestamps and client app ID. It
does not write private keys to disk. A valid chain is reused until its lifetime
expires and is then replaced atomically.

## Runtime configuration

The built-in provider is selected automatically:

```env
INFINITEAPI_TRANSPORT=native_android
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
```

Its state directory can be changed when required:

```env
INFINITEAPI_NATIVE_ANDROID_STATE_DIR=./sessions/native-android-attestation
```

Applications constructing `makeWASocket()` directly may omit
`nativeAndroid.attestationProvider`. InfiniteAPI creates the built-in provider
for a fresh session. A custom provider remains supported as an explicit
override.

## Technical scope

The generated certificates are ordinary Node.js X.509 certificates. They are
not presented as Android Keystore certificates. The live compatibility path
was validated through QR pairing, reconnect, restart, message send/receive and
the three supported authentication backends. This distinction is retained in
the documentation so operational support does not imply a false claim about
certificate provenance.
