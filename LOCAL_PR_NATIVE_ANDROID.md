# Native Android transport delivery dossier

Base: `develop`
Branch: `codex/native-android-transport`

## Delivery status

`native_android` is a supported, explicit opt-in transport. Web remains the
unchanged default. The implementation is self-contained in InfiniteAPI and
does not require an APK, Android emulator or HTTP provider bridge.

Runtime selection remains orthogonal to authentication storage:

- transport: `web` or `native_android`;
- storage: legacy JSON, single SQLite or multi-DB SQLite;
- application identity: Business or Consumer, selected before a fresh QR.

## Protocol implementation

The official Android chat transport captured in the controlled environment
uses:

- raw TCP to `g.whatsapp.net:443`;
- optional `ED\0\1` routing header;
- `WA\x06\x03`;
- three-byte big-endian frame lengths;
- Noise XX for fresh registration;
- Noise IK for registered reconnect;
- server-requested XX fallback.

`WAM\x05` is analytics telemetry and is not used as the chat transport.

The native implementation includes:

- raw TCP socket integration with the existing streaming Noise decoder;
- Android ClientPayload registration, first-login and reconnect phases;
- byte-for-byte regression fixtures for the captured 557-byte, 301-byte and
  304-byte plaintext payloads;
- persistent certified responder static key and successful-login counter;
- Android linked-device QR format;
- Business and Consumer application identities with cross-application
  validation;
- immutable persisted device identity across reconnect and restart;
- profile catalog validation and generic captured fallback;
- built-in persistent Node X.509 pairing provider;
- optional custom provider override.

## Built-in pairing provider

The Node provider creates and persists the root-first X.509 chain consumed by
the pairing reply, emits an empty `gpia` and uses the audited application ID:

- Business: `473039703209605`;
- Consumer: `994766073959253`.

Business and Consumer chains are isolated. Only public certificate bytes and
timestamps are persisted. No APK or Android service participates in the
runtime.

The certificates are ordinary Node.js X.509 certificates, not Android Keystore
certificates. This provenance is documented explicitly while the supported
compatibility behavior is based on completed live tests.

## Session and storage guarantees

- Web remains the default and its socket path is unchanged.
- Native Android is enabled only through explicit configuration.
- Existing Web sessions are never converted automatically.
- Registered Business and Consumer identities never change silently.
- A selected hardware profile is copied into credentials and never rerolled
  during reconnect or restart.
- JSON, single SQLite and multi-DB SQLite persist the same durable transport
  identity.
- Public message APIs and events remain transport-independent.

## Additional parity and reliability work

The branch also includes:

- history-sync persistence and shutdown drain ordering;
- message type/status mirrors aligned with decoded payloads;
- identity-row repair;
- view-once and album classification;
- sticker-pack persistence;
- live-location lifecycle and fast-ratchet persistence;
- poll/reaction/add-on mirror isolation;
- newsletter MEX notification handling;
- Bad-MAC socket containment;
- documentation for storage, transport, locations and sticker packs.

## Validation baseline

The completed validation covered:

- fresh QR and expected cross-application rejection;
- post-pair restart and reconnect;
- process restart with durable identity;
- text, media and interactive send/receive;
- receipts, reactions, polls and retries;
- history sync and LID mapping;
- JSON, single SQLite and multi-DB SQLite persistence;
- message, sticker and location mirrors;
- TypeScript build, focused regression suites and diff validation.

See:

- `docs/NATIVE_ANDROID_TRANSPORT.md`
- `docs/NATIVE_ANDROID_NODE_ATTESTATION.md`
- `docs/STORAGE_AND_TRANSPORT.md`
- `docs/LOCATION_MESSAGES.md`
- `docs/STICKER_PACKS.md`
