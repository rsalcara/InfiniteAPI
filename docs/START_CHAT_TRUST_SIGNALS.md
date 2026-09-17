# Native start-chat trust signals

InfiniteAPI observes Android's first-chat integrity lookup when a direct
recipient is resolved for the first time. This is the default native-Android
behavior and remains advisory.

## Configuration

```ts
makeWASocket({
	transportProfile: 'native_android',
	nativeAndroid: {
		// Required native Android fields
	},
	startChatTrustSignalsPolicy: 'observe'
})
```

- There is no external provider. The official `StartChatContextIntegrityQuery`
  runs directly from the motor.
- `startChatTrustSignalsMode` defaults to `native` for
  `transportProfile: 'native_android'` and `off` for Web.
- Explicit `off` disables the lookup on any transport.
- `observe` does not block the send, but the first lookup for a recipient can
  add up to 10 seconds while the motor waits for the official query.
- A durable observation is reused on subsequent sends for the same recipient.
  This keeps the native lookup one-shot per durable contact observation instead
  of issuing repeated GraphQL queries from the motor.
- `require-known` remains a laboratory-only policy and is rejected when
  `NODE_ENV=production`.

## Official lifecycle

The native path uses `StartChatContextIntegrityQuery` through `w:mex`:

```text
query_id: 26204539559207163
component: whatsapp-android-mex
data path: xwa2_fetch_wa_users
use case: CHAT_FMX
context: INTERACTIVE
```

The query runs only after USync has resolved the destination LID. This follows
Android's use of the chat recipient's raw user JID and avoids sending a stale
PN alias. A previously received, still-valid privacy token can be attached as
Base64 with its timestamp as a string. InfiniteAPI never creates a token when
one is absent.

The operation is asynchronous preparation and observation in the official
client; it is not proof that Meta will accept the message. Absence of a token or
trust signal is not interpreted as a hard authorization failure.

## Parsing and persistence

Only the two fields persisted by the Android `start_chat_trust_signals`
lifecycle are retained:

```ts
{
	isSenderNewAccount?: boolean
	isSenderSuspicious?: boolean
}
```

The store also records the local observation time in the official
`created_ts` column. The three built-in adapters persist it as follows:

```text
JSON / multi-file: <auth-dir>/start-chat-trust-signals.json
SQLite mono:       start_chat_trust_signals
SQLite multi-DB:   wa.db / start_chat_trust_signals
```

The multi-DB form uses the official table name and the official contact-delete
trigger. SQLite mono and JSON preserve the same record shape, but do not carry
the full WhatsApp mobile relational schema.

The built-in adapters expose a point read as well as save/export/import. Before
dispatching a native query, the motor reads the durable observation and emits a
known state from that record when present. A failed cache read falls back to the
native query; it never invents a known state.

Raw GraphQL responses, privacy tokens, nonce material, and integrity payloads
are not logged or persisted by this feature.

`migrateAuthState` transfers these observations between built-in adapters.
Custom stores may opt in through optional `exportState`/`importState` methods;
when a non-empty source cannot be migrated, migration reports a warning instead
of silently claiming a complete snapshot.

With the default `skipExisting: true`, migration does not overwrite an existing
destination observation with an older source row. Explicit `skipExisting: false`
preserves the upsert semantics for controlled recovery flows.

The known state is emitted on:

```text
start-chat.trust-signals
```

Applications can additionally receive the state through
`onStartChatTrustSignals`. The state contains a recipient JID, so consumers
must handle it with normal contact metadata safeguards; only the two trust
booleans and local `createdTs` are non-sensitive protocol observations.

The emitted `jid` remains the caller's public PN identity. The native query
uses the canonical LID internally and persists the observation under that LID
when the adapter has the official relational schema.

## APK evidence

Verified in WhatsApp Android `2.26.37.1`:

- operation IDs:
  `assets/whatsapp-android-mex_client_persist_ids.json`;
- request builder: `X/RunnableC41681Icj.java`, case `34`;
- response matching and profile parsing: `X/HZG.java`;
- `start_chat_trust_signals` persistence: `X/RunnableC41681Icj.java` and
  `X/C24499Akk.java`;
- first-chat trigger: `X/AnonymousClass296.java`, invoked through
  `X/C65552wF.java`;
- durable point read in `X/C2Yg.java`
  (`QUERY_START_CHAT_TRUST_SIGNALS_BY_JID`) and manager reuse in
  `X/C30391Uk.java`.
