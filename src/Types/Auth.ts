import type { proto } from '../../WAProto/index.js'
import type { Contact } from './Contact'
import type { HistorySyncStore } from './HistorySync'
import type { MinimalMessage } from './Message'
import type { PersistedNativeAndroidIdentity, PersistedWebTransportIdentity } from './Transport'

export type KeyPair = { public: Uint8Array; private: Uint8Array }
export type SignedKeyPair = {
	keyPair: KeyPair
	signature: Uint8Array
	keyId: number
	timestampS?: number
}

export type ProtocolAddress = {
	name: string // jid
	deviceId: number
}
export type SignalIdentity = {
	identifier: ProtocolAddress
	identifierKey: Uint8Array
}

export type LIDMapping = {
	pn: string
	lid: string
}

export type LTHashState = {
	version: number
	hash: Buffer
	indexValueMap: {
		[indexMacBase64: string]: { valueMac: Uint8Array | Buffer }
	}
}

export type SignalCreds = {
	readonly signedIdentityKey: KeyPair
	readonly signedPreKey: SignedKeyPair
	readonly registrationId: number
}

export type AccountSettings = {
	/** unarchive chats when a new message is received */
	unarchiveChats: boolean
	/** the default mode to start new conversations with */
	defaultDisappearingMode?: Pick<proto.IConversation, 'ephemeralExpiration' | 'ephemeralSettingTimestamp'>
}

export type AuthenticationCreds = SignalCreds & {
	readonly noiseKey: KeyPair
	readonly pairingEphemeralKeyPair: KeyPair
	advSecretKey: string

	me?: Contact
	account?: proto.IADVSignedDeviceIdentity
	signalIdentities?: SignalIdentity[]
	myAppStateKeyId?: string
	firstUnuploadedPreKeyId: number
	nextPreKeyId: number

	lastAccountSyncTimestamp?: number
	platform?: string

	processedHistoryMessages: MinimalMessage[]
	/** number of times history & app state has been synced */
	accountSyncCounter: number
	accountSettings: AccountSettings
	registered: boolean
	pairingCode: string | undefined
	lastPropHash: string | undefined
	routingInfo: Buffer | undefined
	additionalData?: any | undefined
	/**
	 * Durable protocol marker and complete device identity for native-Android
	 * sessions. Absent means the established Web session format.
	 */
	nativeAndroidIdentity?: PersistedNativeAndroidIdentity
	/** Durable Web preset/browser identity. Added lazily to legacy sessions. */
	webTransportIdentity?: PersistedWebTransportIdentity
}

export type SignalDataTypeMap = {
	'pre-key': KeyPair
	session: Uint8Array
	'sender-key': Uint8Array
	'sender-key-memory': { [jid: string]: boolean }
	'app-state-sync-key': proto.Message.IAppStateSyncKeyData
	'app-state-sync-version': LTHashState
	'lid-mapping': string
	'device-list': string[]
	tctoken: { token: Buffer; timestamp?: string; senderTimestamp?: number; realIssueTimestamp?: number | null }
	'tctoken-job': {
		canonicalJid: string
		requestedJid: string
		aliases: string[]
		issueTimestamp: number
		state: 'pending' | 'in_flight' | 'retry' | 'terminal'
		attemptCount: number
		nextRetryAt: number
		leaseUntil: number
		timeoutMs: number
		createdAt: number
		updatedAt: number
		lastStatus?: number
		lastError?: string
	}
	/** Identity key for Signal Protocol - used for detecting contact reinstalls */
	'identity-key': Uint8Array
	/**
	 * Eight-chain sender-key state used by Android live-location updates.
	 * Every auth adapter persists this through its existing key-store path;
	 * multi-db additionally retains signal_kv as the compatibility fallback.
	 */
	'fast-ratchet-sender-key': {
		senderKeyId: number
		iteration: number
		chainKeys: Buffer[]
		signingPublic: Buffer
		signingPrivate: Buffer
	}
}

export type SignalDataSet = { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }

/** Names of the typed records a {@link SignalKeyStore} holds. */
export type SignalDataType = keyof SignalDataTypeMap

/** Identifies one (type, id) record in the key store — the unit of locking. */
export type RecordRef = {
	type: SignalDataType
	id: string
}

/**
 * Internal capability exposed by auth-state adapters that make the relational
 * Trusted Contacts tables authoritative for `tctoken` values. Socket code uses
 * this capability instead of inferring authority from `SocketConfig.multiDbStore`,
 * which may be configured only for unrelated mirrors/caches.
 */
export type TrustedContactTokenStore = {
	readonly authoritative: true
	listIncoming(): Array<{ jid: string; timestamp: number }>
	compareAndPrune(jid: string, expectedTimestamp: number, expectedToken: Uint8Array): Promise<boolean>
}

/**
 * Authoritative per-key upload state exposed by auth adapters backed by the
 * typed `prekeys` table. Socket code must use this capability instead of
 * opening an arbitrary `SocketConfig.multiDbStore` as though it owned the
 * auth-state cursor.
 */
export type PrekeyUploadStore = {
	readonly authoritative: true
	reserveUploadRange(fromId: number, toId: number, timestampSec: number): number
	commitUpload(fromId: number, toId: number, timestampSec: number): void
	countUnsent(): number
	firstUnsentId(): number | null
	nextGeneratedId(): number | null
	markDirectDistribution(prekeyId: number, timestampSec?: number): boolean
	isDirectDistribution(prekeyId: number): boolean
}

type Awaitable<T> = T | Promise<T>

export type SignalKeyStore = {
	get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Awaitable<{ [id: string]: SignalDataTypeMap[T] }>
	set(data: SignalDataSet): Awaitable<void>
	/** clear all the data in the store */
	clear?(): Awaitable<void>
	/**
	 * Enumerate every (id, value) pair for a type. Optional so existing user-implemented
	 * stores keep compiling; required by future auth-state migration / bulk operations
	 * (Stage 5+ in the upstream concurrency rewrite — not yet ported to InfiniteAPI).
	 * Adapters should stream rather than buffer the whole result set into memory.
	 */
	list?<T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<readonly [id: string, value: SignalDataTypeMap[T]]>
	/**
	 * Ids-only fast path for enumeration. Optional. Adapters that can satisfy this
	 * without reading values (e.g. SQL `SELECT id`) should implement it; callers that
	 * need values can still fall back to `list`.
	 */
	listIds?<T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<string>
	/** Present only when this exact key store owns authoritative relational tctokens. */
	trustedContactTokens?: TrustedContactTokenStore
	/** Present only when this exact key store owns authoritative typed prekeys. */
	prekeyUploads?: PrekeyUploadStore
}

/**
 * Scope declaration for {@link SignalKeyStoreWithTransaction.transactWith}.
 *
 * The records list names the (type, id) pairs the transaction's TOP-LEVEL
 * `transactWith` call will read or write. Locks at this level are acquired
 * in a deterministic sorted order via the LockManager, so two transactions
 * with overlapping top-level scope acquired in opposite orders cannot
 * deadlock against each other.
 *
 * Deadlock-freedom contract — PR #457 round-3 clarification (Copilot doc fix):
 *
 *   ✅ Two CONCURRENT top-level transactWith calls with the same record set
 *      (or any overlapping pair) declared up-front: cannot deadlock.
 *
 *   ⚠️  Nested transactWith INSIDE another transactWith (the Stage 2 H0
 *      closure permits this) extends the held scope at runtime. If two
 *      concurrent top-level callers each later nest a transactWith that
 *      acquires records IN OPPOSITE ORDERS not visible at the top-level
 *      scope, deadlock is theoretically possible. Mitigations: declare the
 *      full record set at the outer level when feasible, or ensure nested
 *      scopes are subsets of the outer scope (which makes them no-op
 *      acquisitions via heldLocks re-entry).
 *
 *   ⚠️  Mixing `transaction()` (legacy, `__legacy__` namespace) with
 *      `transactWith()` in opposite orders across two concurrent callers
 *      can deadlock. InfiniteAPI enforces ONE direction by convention:
 *      legacy `transaction(meId)` is OUTER, transactWith is INNER. Never
 *      call `transaction()` from inside a `transactWith()`.
 *
 * Stage 2 (upstream #2572) addition.
 */
export type TransactionScope = {
	records: readonly RecordRef[]
}

export type SignalKeyStoreWithTransaction = SignalKeyStore & {
	isInTransaction: () => boolean
	/**
	 * Runs work without inheriting the current AsyncLocalStorage transaction.
	 * Required for deferred callbacks (timers/socket cleanup) that must start a
	 * fresh durable write after the transaction that scheduled them is sealed.
	 */
	runOutsideTransaction?<T>(work: () => Promise<T>): Promise<T>
	/**
	 * Register work that runs only after the outermost durable commit succeeds,
	 * while the transaction's locks are still held. This is for side effects
	 * that must observe committed state without opening a race window before a
	 * competing transaction starts. Throws when called outside a transaction.
	 */
	afterCommit?: (work: () => Awaitable<void>) => void
	/**
	 * @deprecated Use {@link SignalKeyStoreWithRecordTransaction.transactWith}
	 * (available on stores built via Baileys' `addTransactionCapability`),
	 * which acquires record-identifier-keyed locks rather than a single
	 * caller-chosen string key. Scheduled for removal in v8.
	 *
	 * Stage 2 fixed the nested-bypass behavior (H0): re-entering this method
	 * with a key not already held by an outer transaction now acquires its
	 * own lock instead of silently sharing the outer's lock. Same-key nested
	 * calls still bypass (re-entry safety).
	 */
	transaction<T>(exec: () => Promise<T>, key: string): Promise<T>
	/**
	 * Optional record-scoped transaction surface. Added in Stage 2 as an
	 * additive capability — existing user-implemented stores that only
	 * provide `transaction()` keep compiling. Baileys' own
	 * `addTransactionCapability` returns a store that implements it; internal
	 * callers narrow to {@link SignalKeyStoreWithRecordTransaction} when
	 * they need a non-optional surface.
	 */
	transactWith?<T>(scope: TransactionScope, work: () => Promise<T>): Promise<T>
	/**
	 * Cleanup hook called on socket close. Returns Promise so the caller can
	 * await graceful drainage of in-flight transactions before tearing down
	 * dependent resources (preKeyManager, etc.). PR #453 CodeRabbit fix —
	 * widened from `() => void` to support the active-transaction drain loop
	 * in `addTransactionCapability.destroy()`.
	 */
	destroy?: () => Awaitable<void>
}

/**
 * Variant of {@link SignalKeyStoreWithTransaction} that requires
 * `transactWith`. Baileys' own `addTransactionCapability` returns this
 * concrete shape, so internal call sites (`libsignal`, `messages-send`, etc.)
 * get the precise method signature without null-checking the optional
 * `transactWith` field on every call.
 *
 * Third-party stores can opt in by implementing this interface explicitly
 * when they're ready for the record-scoped API. Stores that only implement
 * the legacy `transaction()` continue to satisfy
 * {@link SignalKeyStoreWithTransaction}.
 *
 * Stage 2 (upstream #2572) addition.
 */
export type SignalKeyStoreWithRecordTransaction = SignalKeyStoreWithTransaction & {
	transactWith<T>(scope: TransactionScope, work: () => Promise<T>): Promise<T>
	afterCommit(work: () => Awaitable<void>): void
	runOutsideTransaction<T>(work: () => Promise<T>): Promise<T>
}

export type TransactionCapabilityOptions = {
	maxCommitRetries: number
	delayBetweenTriesMs: number
}

export type SignalAuthState = {
	creds: SignalCreds
	keys: SignalKeyStore | SignalKeyStoreWithTransaction
}

export type AuthenticationState = {
	creds: AuthenticationCreds
	keys: SignalKeyStore
	/** Durable history-sync work queue. Built-in auth adapters always provide it. */
	historySync?: HistorySyncStore
}
