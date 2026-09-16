import { jest } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG, WABA_CLIENT_APP_ID } from '../../Defaults'
import type { AuthenticationState, NativeAndroidTransportConfig, SocketConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import type { BinaryNode } from '../../WABinary'

type FakeSocketClient = Record<string, any>

const integrityTestClients = globalThis as typeof globalThis & {
	__infiniteApiIntegrityTestClients?: FakeSocketClient[]
}
integrityTestClients.__infiniteApiIntegrityTestClients ??= []
const clients = integrityTestClients.__infiniteApiIntegrityTestClients!

const mockMakeFakeSocketClient = () =>
	class FakeSocketClient {
		constructor(public config: SocketConfig) {
			this.listeners = new Map()
			clients.push(this)
		}

		listeners: Map<string, Set<(payload?: unknown) => void>>

		on(event: string, listener: (payload?: unknown) => void) {
			if (!this.listeners.has(event)) this.listeners.set(event, new Set())
			this.listeners.get(event)!.add(listener)
		}

		off(event: string, listener: (payload?: unknown) => void) {
			this.listeners.get(event)?.delete(listener)
		}

		removeAllListeners(event?: string) {
			if (event) this.listeners.delete(event)
			else this.listeners.clear()
		}

		emit(event: string, payload?: unknown) {
			for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload)
			return true
		}

		get isOpen() {
			return true
		}

		get isClosed() {
			return false
		}

		get isClosing() {
			return false
		}

		get isConnecting() {
			return false
		}

		connect() {}

		close() {
			this.emit('close', false)
		}

		send(_data: Uint8Array | string, callback?: (error?: Error) => void) {
			callback?.()
			return true
		}
	}

jest.unstable_mockModule('../../Socket/Client/websocket', () => ({
	WebSocketClient: mockMakeFakeSocketClient()
}))
jest.unstable_mockModule('../../Socket/Client/tcp', () => ({ TcpSocketClient: mockMakeFakeSocketClient() }))

const makeWASocket = (await import('../../Socket')).default

const nativeAndroidBase: NativeAndroidTransportConfig = {
	enabled: true,
	appVariant: 'business',
	appVersion: [2, 26, 27, 83],
	historySync: {
		fullSyncDaysLimit: 365,
		fullSyncSizeMbLimit: 4096,
		thumbnailSyncDaysLimit: 30,
		supportGroupHistory: false,
		onDemandReady: true,
		supportHatchHistory: false,
		supportedBotChannelFbids: ['1807055946647696']
	},
	attestationProvider: async () => ({
		keyAttestation: Buffer.from([1]),
		gpia: Buffer.alloc(0),
		clientAppId: WABA_CLIENT_APP_ID
	}),
	device: {
		profileId: 'integrity-wiring-fixture',
		manufacturer: 'fixture-manufacturer',
		device: 'fixture-device',
		osVersion: '15',
		osBuildNumber: 'fixture-build',
		phoneId: 'fixture-phone-id',
		deviceExpId: 'fixture-device-exp-id',
		mcc: '724',
		mnc: '05',
		localeLanguageIso6391: 'pt',
		localeCountryIso31661Alpha2: 'BR',
		deviceBoard: 'fixture-board',
		deviceModelType: 'fixture-model',
		yearClass: 2024,
		memClass: 8192,
		oc: false
	}
}

const safetynetChallengeNode = (): BinaryNode => ({
	tag: 'ib',
	attrs: {},
	content: [
		{
			tag: 'safetynet',
			attrs: {},
			content: [{ tag: 'integrity', attrs: { nonce: 'wiring-nonce' } }]
		}
	]
})

const latestClient = () => {
	const client = clients.at(-1)
	if (!client) throw new Error('socket client was not created')
	return client
}

const waitFor = async (predicate: () => boolean) => {
	for (let index = 0; index < 100 && !predicate(); index++) {
		await new Promise(resolve => setImmediate(resolve))
	}
}

const waitForEventLoopDrain = async () => {
	for (let index = 0; index < 5; index++) {
		await new Promise(resolve => setImmediate(resolve))
	}
}

describe('native_android integrity socket wiring', () => {
	it('ignores integrity challenges on the web transport', async () => {
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} as AuthenticationState['keys'] },
			transportProfile: 'web'
		})
		const updates: unknown[] = []
		socket.ev.on('native-android.integrity', update => updates.push(update))

		latestClient().emit('CB:ib,,safetynet', safetynetChallengeNode())
		await waitForEventLoopDrain()

		expect(updates).toEqual([])
		await socket.end(new Error('test complete'))
	})

	it('treats a SafetyNet challenge without a provider as unavailable', async () => {
		let gpiaProviderCalls = 0
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} as AuthenticationState['keys'] },
			transportProfile: 'native_android',
			nativeAndroid: {
				...nativeAndroidBase,
				integrityProvider: challenge => {
					gpiaProviderCalls += 1
					return Promise.reject(new Error(`unexpected GPIA provider call for ${challenge.kind}`))
				}
			}
		})
		const updates: unknown[] = []
		socket.ev.on('native-android.integrity', update => updates.push(update))

		latestClient().emit('CB:ib,,safetynet', safetynetChallengeNode())
		await waitFor(() => updates.length > 0)

		expect(updates).toEqual([
			expect.objectContaining({
				kind: 'safetynet',
				status: 'unavailable',
				action: 'challenge-observed',
				reason: 'provider-not-configured'
			})
		])
		expect(gpiaProviderCalls).toBe(0)
		await socket.end(new Error('test complete'))
	})

	it('invokes a configured provider for SafetyNet instead of marking its wire unsupported', async () => {
		let receivedKind: string | undefined
		let rejectProvider: ((error: Error) => void) | undefined
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: { creds: initAuthCreds(), keys: {} as AuthenticationState['keys'] },
			transportProfile: 'native_android',
			nativeAndroid: {
				...nativeAndroidBase,
				integrityPolicy: 'enforce',
				safetyNetIntegrityProvider: challenge =>
					new Promise((_, reject) => {
						receivedKind = challenge.kind
						rejectProvider = reject
						challenge.signal.addEventListener('abort', () => reject(new Error('provider aborted by socket teardown')), {
							once: true
						})
					})
			}
		})
		const updates: unknown[] = []
		socket.ev.on('native-android.integrity', update => updates.push(update))

		latestClient().emit('CB:ib,,safetynet', safetynetChallengeNode())
		await waitFor(() => receivedKind === 'safetynet')

		expect(receivedKind).toBe('safetynet')
		expect(updates).toEqual([expect.objectContaining({ kind: 'safetynet', status: 'pending' })])
		expect(updates).not.toEqual([expect.objectContaining({ status: 'unsupported' })])

		await socket.end(new Error('test complete'))
		rejectProvider?.(new Error('provider aborted by test'))
		await new Promise(resolve => setImmediate(resolve))
		expect(updates.some(update => (update as { status?: string }).status === 'unsupported')).toBe(false)
	})
})
