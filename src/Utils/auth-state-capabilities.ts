import type {
	AppStateSyncKeyStore,
	AuthenticationState,
	AuthStateCapabilities,
	AuthStateStorageMetadata
} from '../Types'

const REQUIRED_APP_STATE_SYNC_STORE_METHODS = [
	'recordMissingKey',
	'listMissingKeyIds',
	'listMissingCollections',
	'resolveKeys',
	'enqueuePeerMessage',
	'listPeerMessages',
	'listUnackedPeerMessages',
	'markPeerMessageAcked',
	'deletePeerMessages',
	'exportState',
	'importState',
	'clear'
] as const satisfies ReadonlyArray<keyof AppStateSyncKeyStore>

export type AuthStateCapabilityInspection = {
	capabilities: AuthStateCapabilities
	/** Present only when the store contract and durability marker are valid. */
	appStateSyncKeys?: AppStateSyncKeyStore
}

export type DurableAppStateSyncKeyStoreOptions = {
	persistence: 'durable'
}

const missingStoreMethods = (store: unknown): string[] => {
	if (!store || typeof store !== 'object') return [...REQUIRED_APP_STATE_SYNC_STORE_METHODS]
	const candidate = store as Record<string, unknown>
	return REQUIRED_APP_STATE_SYNC_STORE_METHODS.filter(method => {
		try {
			return typeof candidate[method] !== 'function'
		} catch {
			// A hostile getter/proxy is an invalid store. Keep socket creation
			// fail-closed instead of allowing adapter inspection to throw.
			return true
		}
	})
}

const bindValidatedStore = (store: AppStateSyncKeyStore): AppStateSyncKeyStore => ({
	durable: true,
	recordMissingKey: store.recordMissingKey.bind(store),
	listMissingKeyIds: store.listMissingKeyIds.bind(store),
	listMissingCollections: store.listMissingCollections.bind(store),
	resolveKeys: store.resolveKeys.bind(store),
	enqueuePeerMessage: store.enqueuePeerMessage.bind(store),
	listPeerMessages: store.listPeerMessages.bind(store),
	listUnackedPeerMessages: store.listUnackedPeerMessages.bind(store),
	markPeerMessageAcked: store.markPeerMessageAcked.bind(store),
	deletePeerMessages: store.deletePeerMessages.bind(store),
	exportState: store.exportState.bind(store),
	importState: store.importState.bind(store),
	clear: store.clear.bind(store)
})

/**
 * Validates the structural contract and records the caller's durability
 * declaration for a custom App State recovery store. Persistence across
 * process restarts remains the caller's responsibility. This wrapper binds
 * prototype methods and never invents or copies state.
 */
export const createAppStateSyncKeyStore = (
	store: AppStateSyncKeyStore,
	options: DurableAppStateSyncKeyStoreOptions
): AppStateSyncKeyStore => {
	if (options.persistence !== 'durable') throw new Error('app-state sync key store persistence must be durable')
	const missing = missingStoreMethods(store)
	if (missing.length) throw new TypeError(`invalid app-state sync key store; missing methods: ${missing.join(', ')}`)
	return bindValidatedStore(store)
}

export const inspectAuthStateCapabilities = (
	authState: AuthenticationState,
	instanceId: string,
	accountJid?: string
): AuthStateCapabilityInspection => {
	const metadata: AuthStateStorageMetadata | undefined = authState.storage
	const metadataBackend = metadata?.backend
	const isBuiltInBackend =
		metadataBackend === 'multifile' || metadataBackend === 'sqlite' || metadataBackend === 'multidb-sqlite'
	const backend = isBuiltInBackend || metadataBackend === 'custom' ? metadataBackend : 'custom'
	const issues: string[] = []
	if (metadataBackend !== undefined && !isBuiltInBackend && metadataBackend !== 'custom') {
		issues.push('storage.backend:unrecognized')
	}

	const store = authState.appStateSyncKeys
	let appStateSyncKeys: AppStateSyncKeyStore | undefined
	let appStateSyncRecoveryReason: AuthStateCapabilities['appStateSyncRecoveryReason']

	if (!store) {
		appStateSyncRecoveryReason = 'missing-store'
		issues.push('appStateSyncKeys:missing')
	} else {
		const missing = missingStoreMethods(store)
		if (missing.length) {
			appStateSyncRecoveryReason = 'invalid-store'
			issues.push(...missing.map(method => `appStateSyncKeys.${method}:missing`))
		} else {
			try {
				if (store.durable === true) {
					appStateSyncKeys = store
				} else {
					appStateSyncRecoveryReason = 'durability-unverified'
					issues.push('appStateSyncKeys.durable:unverified')
				}
			} catch {
				appStateSyncRecoveryReason = 'invalid-store'
				issues.push('appStateSyncKeys.durable:unreadable')
			}
		}
	}

	const builtInBackend = isBuiltInBackend
	const historySyncDurable = builtInBackend && metadata?.historySyncDurable === true && Boolean(authState.historySync)
	const tcTokenDurable = builtInBackend && metadata?.tcTokenDurable === true
	if (metadata?.historySyncDurable === true && !authState.historySync) issues.push('historySync:missing')
	if (!builtInBackend && metadata?.historySyncDurable === true) issues.push('historySync.durable:unverified')
	if (!builtInBackend && metadata?.tcTokenDurable === true) issues.push('tcToken.durable:unverified')

	return {
		capabilities: {
			backend,
			instanceId,
			accountJid,
			appStateSyncRecovery: Boolean(appStateSyncKeys),
			historySyncDurable,
			tcTokenDurable,
			appStateSyncRecoveryReason,
			issues
		},
		appStateSyncKeys
	}
}
