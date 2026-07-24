# Local PR — experimental native Android transport

Status: experimental work-in-progress branch; published for preservation and continued testing, not ready to merge.

Base: `origin/develop` at `47ab8d6e`
Branch: `codex/native-android-transport`

The repository also contains `android-provider-bridge/`, a separately compiled
Android test component with its own package/signing identity. It uses Android
Keystore, exposes only public attestation artifacts on Android loopback, and is
consumed through `makeNativeAndroidBridgeAttestationProvider()`. Runtime
selection is explicit: `INFINITEAPI_TRANSPORT=web|native_android` and
`INFINITEAPI_AUTH_STORAGE=json|sqlite|multi_db_sqlite`. Web remains the default
until the complete native lifecycle is proven.

## Forensic correction that defines this implementation

The captured `WAM\x05` stream is WhatsApp Analytics Metrics telemetry, not the
chat transport. InfiniteAPI already implements that format under `src/WAM`.

The official WhatsApp Business Android chat connection observed in the
controlled emulator uses:

- raw TCP to `g.whatsapp.net:443`;
- an optional `ED\0\1` routing header;
- `WA\x06\x03`;
- a three-byte big-endian frame length;
- Noise handshakes and encrypted transport frames.

Consequently this change reuses InfiniteAPI's existing Noise/framing and adds a
raw TCP socket. It does not create a second WAM dictionary or claim that WAM is
a chat protocol.

The 410-byte official cold-start frame is not the minimal XX `ClientHello`
currently sent by InfiniteAPI. Protobuf decoding proves it is a
`HandshakeMessage.clientHello` with:

- 32-byte ephemeral key;
- 48-byte encrypted static key;
- 320-byte encrypted payload.

That is the Noise IK shape used by an already-paired Android reconnect. A fresh
companion registration can still require XX, but a registered native session
must not be called protocol-equivalent while it continues to reconnect through
the Web-compatible XX path.

Primary evidence:

- `C:\github\WABA-ANDROID-RE\captures\native-socket-transport-coldstart.log`
  lines 8-13: `ED0001`, routing length `000006`, routing bytes
  `08020812080d`, `WA0603`, frame length `00019a`, then the 410-byte Noise
  payload.
- The same capture, lines 24-31, shows WAM traffic inside a separate TLS HTTP
  request to `/deidentified_telemetry` with `WaMsysRequest: 1`.

Older notes that label `WAM\x05` as the chat header are superseded by this
socket-level capture. They had conflated analytics serialization with the
independent chat socket.

## Implemented locally

- Stable `web` transport remains the default.
- Explicit experimental `native_android` transport profile.
- Raw TCP socket client, feeding arbitrary TCP chunks into the existing
  streaming Noise decoder.
- Native `SMB_ANDROID` ClientPayload with four-part app version, genuine device
  fields, `PHONE` type, Android companion props and no `WebInfo`.
- The registered-login `ClientPayload` is reproduced byte for byte against the
  official 304-byte plaintext captured before Noise encryption. This includes
  the absence (not merely the default value) of `releaseChannel`, `WebInfo` and
  `pull`, plus `passive=false`.
- Per-connection fields now follow the official lifecycle: a fresh signed
  32-bit `sessionId`, `shortConnect`, DNS source, connect attempt count,
  connection-sequence bit field and connect reason are built for each socket.
- The durable `connectionLc` value is read into the handshake and incremented
  only after the server's `success` node, wrapping from `INT32_MAX` to zero.
- The certified Noise responder static public key learned during XX is
  persisted with the native identity, only after the WhatsApp certificate chain
  is verified. Its bytes are never logged. This prepares the durable state
  required by IK.
- Registered native sessions with that certified key use the classic
  `Noise_IK_25519_AESGCM_SHA256` reconnect sequence recovered from the APK:
  `e, es, s, ss, payload`, followed by the server's `e, ee, se, payload`.
- If an IK `ServerHello` contains a static key, the transcript is restarted as
  `Noise_XXfallback_25519_AESGCM_SHA256` exactly as the official state machine
  does; the certified replacement responder key is persisted after certificate
  verification.
- Android `DeviceProps` uses the same four-part version and the build-hash
  transformation recovered from the APK (MD5 hex string decoded as Base64).
- Dynamic history-sync limits/feature flags are required from a genuine
  device/remote-config snapshot; the library does not invent them.
- Native QR uses the official linked-devices URL form; Web QR remains unchanged.
- Phone-number pair code fails explicitly in native mode instead of pretending
  that the Web pair-code flow is Android-native.
- Pairing requires a provider of genuine `key_attestation`, `gpia` and
  `client-app-id` artifacts. The controlled WABA 2.26.27.83 fresh-QR capture
  emitted a 2,039-byte `key_attestation`, an empty `gpia` node and a 15-byte
  `client-app-id`, in that order. No value is synthesized.
- The official client does not generate attestation from the pair-success
  stanza. `94R.A00()` refreshes a cached artifact through
  `KeyAttestationLifetimeManagerKt`, controlled by remote parameters `0x1921`
  and `0x1922`; the pairing coroutine reads that cache. Consequently the
  provider owns refresh/freshness, while InfiniteAPI deliberately never stores
  captured attestation bytes in auth state.
- Full native identity is persisted in `AuthenticationCreds` and reused across
  reconnects/restarts.
- Native QR `pair-success` now persists `registered: true`. Existing local
  native sessions that already contain the durable identity plus `account` and
  `me` self-heal this marker on the next open, and the marker is included in
  the deferred `creds.update` used by all three auth backends.
- Existing unmarked Web sessions cannot be converted to native Android.
- Native sessions cannot be opened with the Web transport.
- A changed device profile is rejected rather than silently rotating identity.
- The generic captured profile fallback is disabled as soon as registration is
  proven by either `registered` or the persisted `account` + `me` pair.
- Only `selectedProfileId` is logged; `phoneId` and attestation bytes are not.
- Persistence is covered in legacy multi-file, monolithic SQLite and multi-DB
  SQLite auth stores without backend-specific schema duplication, including
  the certified responder key and successful-login counter.

## Official registered ClientPayload evidence

The controlled WABA reconnect was captured twice at
`X.1Sm -> AbstractMessageLite.toByteArray()` before Noise encryption. Both
payloads were exactly 304 bytes. Stable fields were identical; dynamic fields
changed with the connection lifecycle.

Confirmed stable fields:

- `platform=SMB_ANDROID`, app version `2.26.27.83`;
- complete `Build.*` and per-installation identity tuple;
- `passive=false`, no `WebInfo`, no explicit `releaseChannel`, no `pull`;
- `shortConnect=true`, `connectReason=USER_ACTIVATED`;
- `dnsSource={dnsMethod:MNS, appCached:false}`;
- `connectAttemptCount=0`, `trafficAnonymization=OFF`;
- `oc=true`, `yearClass=2016`, `memClass=192`;
- `lidDbMigrated=true`, `paaLink=false`.

Confirmed dynamic fields:

- capture 1: `sessionId=451263734`, `lc=11`,
  `connectionSequenceInfo=133`;
- capture 2: `sessionId=-1957523145`, `lc=13`,
  `connectionSequenceInfo=134`.

The APK explains these changes: `sessionId` comes from `Random.nextInt()`;
`connection_lc` is read before the handshake and incremented only after login
success; `connectionSequenceInfo` is a compact port/address-source/proxy/
sequence/network-capability bit field.

## Official fresh-registration evidence

A fresh isolated Android user was paired twice with the read-only capture
active. Both runs produced the same protocol shape with new per-installation
identity/key material:

- fresh registration payload: exactly 557 bytes;
- first login after QR: exactly 301 bytes;
- `shortConnect=true` in both phases;
- fresh registration: `passive=false`, `connectReason=UNKNOWN`,
  `dnsSource={SYSTEM,true}`, `lc=0`, port-derived sequence value `133`;
- first login: `passive=true`, the same DNS/reason tuple, `lc=0`,
  port-derived sequence value `134`;
- neither phase emits `pull` or `lidDbMigrated`;
- the registration `DeviceProps.platformType` is `ANDROID_AMBIGUOUS`, not
  `ANDROID_PHONE`;
- `recentSyncDaysLimit=0` is explicitly present in the captured DeviceProps.

The implementation now models `registration`, `initial_pair_login` and
`reconnect` as separate payload phases. Regression tests reproduce the full
557-byte registration payload, the full 301-byte first-login payload and the
previously captured 304-byte reconnect payload byte for byte.

The final reply-node content remains supplied through the attestation provider.
The controlled emulator could build and complete the companion registration,
but its platform-integrity service was not available after the host restart.
The library therefore keeps the existing fail-closed provider boundary and
does not synthesize device-integrity output.

## Configuration contract

The consumer must explicitly select `transportProfile: 'native_android'` and
provide a complete, real device profile plus the current official Android app
version. Optional initial ED routing bytes may be supplied only when acquired
from the official routing lifecycle; persisted `creds.routingInfo` wins.

Native QR pairing deliberately fails at `pair-success` if no genuine
attestation provider is configured. This is a safety boundary, not a missing
synthetic default.

## Compatibility guarantees

- Public socket/message routes are unchanged.
- Web code path and default URL remain unchanged.
- No registered Web/SMB session is automatically converted.
- No Android manufacturer/model/build/phone identity is generated by the
  library.
- Legacy, mono-DB and multi-DB persist the same durable transport marker.

## Validation completed locally

- Android provider APK: Gradle 8.9 `:app:assembleDebug` passes with the
  repository wrapper.
- Provider smoke test on the controlled emulator: install/start passes,
  loopback `/health` reports the expected package, and `/v1/attestation`
  returns a fresh Android Keystore certificate chain. The TypeScript bridge
  accepts that live response and reports 2,058 bytes of public attestation
  data, an empty `gpia`, and the configured test client id. The placeholder
  client id used for this local contract test is not evidence of WhatsApp
  server authorization.
- Provider/transport/persistence regression on Linux Node 22: 3 suites and
  28/28 tests pass, including legacy JSON, monolithic SQLite and multi-DB
  SQLite persistence.
- TypeScript `tsc --noEmit`: pass.
- Exact ClientPayload regression: the generated registered payload equals the
  full captured 304-byte hex string, not only a selected field subset.
- Exact fresh-registration and first-login regressions reproduce the captured
  557-byte and 301-byte payloads byte for byte.
- Focused transport/contract/persistence matrix: 12 suites pass, 92 tests pass
  and 2 existing TODOs remain.
- Focused native transport tests: 21/21 pass after the registration lifecycle,
  exact-payload and phase-selection additions.
- Existing Noise tests now include an exact regression for the captured
  `ED + routing + WA\x06\x03 + 3-byte length` intro.
- An independent responder test validates the complete classic IK key schedule,
  decrypts the client static key and payload, completes the server response and
  proves both sides derive the same first transport key.
- A capture-shape regression proves a 304-byte plaintext produces the official
  410-byte protobuf frame with fields `32 / 48 / 320`.
- Linux/Node 22 build: pass.
- Full Linux suite: 106 suites and 1,401 tests pass. One unrelated,
  environment-sensitive `browser-utils` suite has three pre-existing failures
  because Debian 12 is detected as version `"12"` while that test assumes an
  Ubuntu `major.minor` release.
- Global lint is currently blocked by pre-existing CRLF files under
  `src/Signal/Group`; all files touched by this implementation pass the
  repository Prettier configuration.
- Three suites are explicitly skipped, with 6 skipped tests and 5 TODOs.
- Real SQLite tests executed under Node 22, matching the installed native ABI.
- `git diff --check`: pass.

## Required before any real PR or merge

This remains experimental until all of the following pass against a controlled
official-device attestation source:

1. complete fresh QR pairing against the live native endpoint;
2. verify the lifetime-managed attestation provider against a second fresh QR;
3. live IK reconnect without identity change;
4. live server-requested XXfallback;
5. outbound text and interactive messages;
6. inbound messages and receipts;
7. history sync;
8. process restart with legacy, mono-DB and multi-DB storage;
9. routingInfo rotation/reconnect;
10. negative tests for missing/invalid attestation.

Fresh registration (557 bytes), first paired login (301 bytes), and registered
reconnect (304 bytes) now have exact byte parity with their official plaintext
captures. The 320-byte IK reconnect payload field is the 304-byte plaintext
plus a 16-byte AEAD tag. The genuine final official pairing shape is also
captured: `pair-device-sign` contains four children, ending in
`key_attestation`, empty `gpia` and `client-app-id`. A live provider-backed
pairing and the remaining lifecycle validation are still mandatory before this
branch can be described as “99.9% native Android”; it therefore remains
experimental.

No item above should be reported as passed merely from unit tests.
