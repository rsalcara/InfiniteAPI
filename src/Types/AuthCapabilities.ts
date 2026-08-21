export type AuthStateBackend = 'multifile' | 'sqlite' | 'multidb-sqlite' | 'custom'

export type AppStateSyncRecoveryUnavailableReason = 'missing-store' | 'invalid-store' | 'durability-unverified'

export type AuthStateStorageMetadata = {
	/** Stable identifier for the auth adapter that owns the persisted state. */
	backend: AuthStateBackend
	/** True only when history-sync work survives a process restart. */
	historySyncDurable: boolean
	/** True only when trusted-contact tokens survive a process restart. */
	tcTokenDurable: boolean
}

export type AuthStateCapabilities = {
	backend: AuthStateBackend
	/** Consumer-supplied instance id, own JID, or the generated socket id. */
	instanceId: string
	/** Normalized account JID when credentials already identify the account. */
	accountJid?: string
	/** Whether the complete durable type-38/type-39 recovery lifecycle is active. */
	appStateSyncRecovery: boolean
	historySyncDurable: boolean
	tcTokenDurable: boolean
	appStateSyncRecoveryReason?: AppStateSyncRecoveryUnavailableReason
	/** Machine-readable contract failures. Empty when all advertised capabilities are available. */
	issues: string[]
}
