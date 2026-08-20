import { jest } from '@jest/globals'
import type {
	AppStateSyncKeyImportResult,
	AppStateSyncKeyStore,
	AppStateSyncKeyStoreSnapshot,
	AuthenticationState,
	StoredAppStateSyncPeerMessage
} from '../../Types'
import { createAppStateSyncKeyStore, inspectAuthStateCapabilities } from '../../Utils/auth-state-capabilities'
import { initAuthCreds } from '../../Utils/auth-utils'

class CustomAppStateStore implements AppStateSyncKeyStore {
	readonly calls: string[] = []

	async recordMissingKey(): Promise<void> {
		this.calls.push('recordMissingKey')
	}

	async listMissingKeyIds(): Promise<string[]> {
		return []
	}

	async listMissingCollections(): Promise<string[]> {
		return []
	}

	async resolveKeys(): Promise<string[]> {
		return []
	}

	async enqueuePeerMessage(): Promise<StoredAppStateSyncPeerMessage> {
		throw new Error('not used')
	}

	async listPeerMessages(): Promise<StoredAppStateSyncPeerMessage[]> {
		return []
	}

	async listUnackedPeerMessages(): Promise<StoredAppStateSyncPeerMessage[]> {
		return []
	}

	async markPeerMessageAcked(): Promise<void> {}

	async deletePeerMessages(): Promise<void> {}

	async exportState(): Promise<AppStateSyncKeyStoreSnapshot> {
		return { missingKeys: [], peerMessages: [] }
	}

	async importState(): Promise<AppStateSyncKeyImportResult> {
		return { missingKeys: 0, peerMessages: 0 }
	}

	async clear(): Promise<void> {}
}

const authState = (appStateSyncKeys?: AppStateSyncKeyStore): AuthenticationState => ({
	creds: initAuthCreds(),
	keys: {
		get: async () => ({}),
		set: async () => {}
	},
	appStateSyncKeys
})

describe('auth-state recovery capabilities', () => {
	it('reports a missing custom recovery store without claiming unrelated durability', () => {
		const result = inspectAuthStateCapabilities(authState(), 'zpro-main', '5511999999999@s.whatsapp.net')

		expect(result.appStateSyncKeys).toBeUndefined()
		expect(result.capabilities).toEqual({
			backend: 'custom',
			instanceId: 'zpro-main',
			accountJid: '5511999999999@s.whatsapp.net',
			appStateSyncRecovery: false,
			historySyncDurable: false,
			tcTokenDurable: false,
			appStateSyncRecoveryReason: 'missing-store',
			issues: ['appStateSyncKeys:missing']
		})
	})

	it('rejects an incomplete store at runtime', () => {
		const invalid = { recordMissingKey: jest.fn() } as unknown as AppStateSyncKeyStore
		const result = inspectAuthStateCapabilities(authState(invalid), 'invalid-store')

		expect(result.capabilities.appStateSyncRecovery).toBe(false)
		expect(result.capabilities.appStateSyncRecoveryReason).toBe('invalid-store')
		expect(result.capabilities.issues).toContain('appStateSyncKeys.clear:missing')
	})

	it('does not trust a structurally complete store without a durability certificate', () => {
		const result = inspectAuthStateCapabilities(authState(new CustomAppStateStore()), 'unverified-store')

		expect(result.capabilities.appStateSyncRecovery).toBe(false)
		expect(result.capabilities.appStateSyncRecoveryReason).toBe('durability-unverified')
		expect(result.capabilities.issues).toEqual(['appStateSyncKeys.durable:unverified'])
	})

	it('factory validates, binds, and certifies a custom durable store', async () => {
		const source = new CustomAppStateStore()
		const store = createAppStateSyncKeyStore(source, { persistence: 'durable' })
		const state = authState(store)
		state.storage = {
			backend: 'custom',
			historySyncDurable: false,
			tcTokenDurable: true
		}

		await store.recordMissingKey('AAAAAEGV', 'regular')
		const result = inspectAuthStateCapabilities(state, 'custom-durable')

		expect(source.calls).toEqual(['recordMissingKey'])
		expect(store.durable).toBe(true)
		expect(result.appStateSyncKeys).toBe(store)
		expect(result.capabilities).toEqual({
			backend: 'custom',
			instanceId: 'custom-durable',
			accountJid: undefined,
			appStateSyncRecovery: true,
			historySyncDurable: false,
			tcTokenDurable: false,
			appStateSyncRecoveryReason: undefined,
			issues: ['tcToken.durable:unverified']
		})
	})

	it('factory fails closed when a required method is absent', () => {
		const invalid = new CustomAppStateStore() as CustomAppStateStore & { clear?: undefined }
		Object.defineProperty(invalid, 'clear', { value: undefined })

		expect(() => createAppStateSyncKeyStore(invalid as AppStateSyncKeyStore, { persistence: 'durable' })).toThrow(
			'invalid app-state sync key store; missing methods: clear'
		)
	})
})
