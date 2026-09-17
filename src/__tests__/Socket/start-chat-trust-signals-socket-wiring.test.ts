import { jest } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { AuthenticationState, NativeAndroidTransportConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'

type FakeSocketClient = Record<string, any>

const integrityTestClients = globalThis as typeof globalThis & {
	__infiniteApiStartChatTrustTestClients?: FakeSocketClient[]
}
integrityTestClients.__infiniteApiStartChatTrustTestClients ??= []
const clients = integrityTestClients.__infiniteApiStartChatTrustTestClients!

const mockMakeFakeSocketClient = () =>
	class FakeSocketClient {
		readonly sendCalls: string[] = []
		private readonly listeners = new Map<string, Set<(payload?: unknown) => void>>()

		constructor(public config: unknown) {
			clients.push(this)
		}

		on(event: string, listener: (payload?: unknown) => void) {
			const listeners = this.listeners.get(event) ?? new Set()
			listeners.add(listener)
			this.listeners.set(event, listeners)
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

		send(data: Uint8Array | string, callback?: (error?: Error) => void) {
			this.sendCalls.push(String(data instanceof Uint8Array ? Buffer.from(data).toString('hex') : data))
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
	device: {
		profileId: 'start-chat-cache-wiring-fixture',
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

const waitForEventLoopDrain = async () => {
	for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve))
}

describe('start-chat trust signal socket cache wiring', () => {
	it('uses the durable point read and does not dispatch the native query', async () => {
		const requestedJid = '5511999999999@s.whatsapp.net'
		const durableJid = '500123456789@lid'
		const get = jest.fn(async (jid: string) =>
			jid === durableJid
				? {
						jid,
						isSenderSuspicious: false,
						isSenderNewAccount: true,
						observedAt: 1_786_000_000_000
					}
				: null
		)
		const socket = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			auth: {
				creds: initAuthCreds(),
				keys: {} as AuthenticationState['keys'],
				startChatTrustSignals: {
					get,
					save: async () => {}
				}
			},
			nativeAndroid: nativeAndroidBase,
			startChatTrustSignalsMode: 'native',
			transportProfile: 'native_android'
		})
		const updates: unknown[] = []
		socket.ev.on('start-chat.trust-signals', update => updates.push(update))

		const state = await socket.fetchStartChatTrustSignals(requestedJid, { lookupJid: durableJid })
		await waitForEventLoopDrain()

		expect(get).toHaveBeenCalledWith(durableJid)
		expect(state).toMatchObject({
			jid: requestedJid,
			useCase: 'CHAT_FMX',
			status: 'known',
			signals: {
				isSenderSuspicious: false,
				isSenderNewAccount: true,
				createdTs: 1_786_000_000_000
			}
		})
		expect(updates).toEqual([state])
		expect(clients.at(-1)?.sendCalls).toEqual([])

		await socket.end(new Error('start-chat cache wiring test complete'))
	})
})
