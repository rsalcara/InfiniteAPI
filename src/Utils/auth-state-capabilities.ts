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
	return REQUIRED_APP_STATE_SYNC_STORE_METHODS.filter(method => typeof candidate[method] !== 'function')
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
 * Validates and certifies a custom durable App State recovery store.
 * This wrapper binds prototype methods and never invents or copies state.
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
	const backend = metadata?.backend ?? 'custom'
	const issues: string[] = []
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
		} else if (store.durable !== true) {
			appStateSyncRecoveryReason = 'durability-unverified'
			issues.push('appStateSyncKeys.durable:unverified')
		} else {
			appStateSyncKeys = store
		}
	}

	const builtInBackend = backend !== 'custom'
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
