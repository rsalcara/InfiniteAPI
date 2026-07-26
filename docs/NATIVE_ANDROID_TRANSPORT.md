# Native Android transport

## Compatibility contract

InfiniteAPI keeps the Web transport as its stable default:

```ts
makeWASocket({
	transportProfile: 'web'
})
```

Omitting `transportProfile` also resolves to Web. Native Android is never
enabled implicitly and an existing Web session is never converted.

Authentication storage is orthogonal to transport. The same transport contract
can be used with the legacy multi-file state, single-file SQLite or typed
multi-DB SQLite state.

## Explicit native configuration

Native Android requires both gates:

```ts
makeWASocket({
	transportProfile: 'native_android',
	nativeAndroid: {
		enabled: true,
		appVariant: 'business', // or 'consumer'
		appVersion: [2, 26, 27, 83],
		device,
		historySync
	}
})
```

`appVariant` is mandatory. InfiniteAPI does not guess between the two primary
applications:

| Variant | Primary package | Pairing platform | Client app ID |
| --- | --- | --- | --- |
| `business` | `com.whatsapp.w4b` | `smba` / `SMB_ANDROID` | `473039703209605` |
| `consumer` | `com.whatsapp` | `android` / `ANDROID` | `994766073959253` |

Invalid or missing variants fail before a fresh pairing attempt.

## QR and cross-application rejection

The native QR uses the official linked-devices URL form while preserving the
four protocol fields:

```text
https://wa.me/settings/linked_devices#<ref>,<noise>,<identity>,<adv>
```

The QR itself has no mutable Consumer/Business selector. The server-issued
`ref` belongs to the application identity declared by the companion
connection. Scanning with the opposite primary application produces server
error `405` in the scanner and does not emit `pair-success` to the companion.

Consequences:

- one emitted native QR cannot accept both applications;
- the same QR cannot be reclassified after a failed scan;
- orchestration must select the variant before creating the socket;
- changing variants requires closing the unregistered attempt and issuing a
  fresh QR.

## Pair-success validation

For a compatible scan, pair-success reports the primary platform. InfiniteAPI
validates it against the configured identity before building
`pair-device-sign`.

Unknown platforms fail closed. A registered session never enters this
transition and cannot change application identity.

InfiniteAPI initializes its built-in Node X.509 provider for a fresh session.
Applications may still override it with `attestationProvider`. The custom
provider context includes:

```ts
{
	profileId,
	appVariant,
	clientAppId,
	packageName,
	stanza
}
```

Returned material is checked for non-empty payloads and matching
`clientAppId`. Provider implementations must maintain their own lifecycle and
must not expose private material in logs. The built-in provider persists the
public chain separately for Business and Consumer and never requires an APK.

## Durable identity

The first native attempt persists a complete identity:

- transport schema and profile;
- application variant and client app ID;
- selected device profile;
- device identifiers;
- connection counter;
- certified server static key after successful negotiation.

Once registration completes, persisted identity is authoritative. A caller may
change its default for future sessions, but reconnecting an existing session
continues to use its stored Business or Consumer identity and stored hardware
profile.

Legacy native identities without variant metadata are migrated to Business,
matching the only identity supported before variant-aware pairing.

## Device profile rules

A device profile must be complete and internally coherent. Catalog selection,
when used, occurs only for a new session. InfiniteAPI copies the selected
profile into authentication credentials and never selects again on reconnect
or restart.

Logs may contain `selectedProfileId` and the effective application variant.
They must not contain `phoneId`, `deviceExpId`, private keys or provider
artifacts.

## Storage backends

Transport selection does not alter the public auth-state API:

- legacy multi-file state stores the durable identity with credentials;
- single-file SQLite stores it in its credentials record;
- multi-DB SQLite stores it in `creds.db`.

Signal keys, app-state, mappings and message mirrors retain their existing
backend responsibilities. Selecting Business or Consumer does not create a
fourth storage format.

## Orchestrator environment example

Environment variables belong to the consuming application, not to the
InfiniteAPI library itself. A compatible orchestrator can map them as follows:

```env
# Stable default
WHATSAPP_TRANSPORT=web
```

```env
# Explicit Business opt-in
WHATSAPP_TRANSPORT=native_android
NATIVE_ANDROID_APP_VARIANT=business
```

```env
# Explicit Consumer opt-in
WHATSAPP_TRANSPORT=native_android
NATIVE_ANDROID_APP_VARIANT=consumer
```

If `WHATSAPP_TRANSPORT=native_android` is selected without a variant, the
orchestrator should stop with an actionable configuration error.

## Operational validation

The supported validation baseline covers the following lifecycle for both
variants and the supported auth backends:

1. fresh QR registration;
2. expected cross-application `405`;
3. post-pair `515` restart;
4. IK reconnect and supported XX fallback;
5. process restart and durable auto-boot;
6. text, media and interactive send/receive;
7. receipts, reactions, polls and retries;
8. history sync and LID mapping;
9. concurrent teardown without stale store writes;
10. malformed encrypted frames close only their socket, not the host process.

Web remains the default transport. Native Android is enabled only when the
consumer explicitly selects it.

## Runtime resilience and typed-store behavior

- A Noise/GCM frame authentication failure closes only the affected socket;
  other instances and the host process remain alive.
- Shutdown drains active PN/LID mapping work before destroying the auth
  transaction capability or closing SQLite handles.
- Consumed one-time prekeys are deleted from a fresh transaction after their
  grace period instead of reusing a sealed transaction context.
- First-pair history sync has a four-second ordering window before buffered
  live events are released. Late history remains processable.
- Multi-DB sessions mirror history-sync message rows into
  `msgstore.db.message` without incrementing unread counters.
- Full and side-sub text-status pushes are exposed as
  `text-status.update` and `text-status-side-sub.update`.

Consumers should provide a child logger containing their instance identifier.
A reference integration should include `instance`, `backend` and `generation`
in InfiniteAPI logs and reject stale socket callbacks.
