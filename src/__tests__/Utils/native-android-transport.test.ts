import { createHash } from 'crypto'
import net from 'net'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG, NOISE_WA_HEADER } from '../../Defaults'
import { TcpSocketClient } from '../../Socket/Client'
import type { NativeAndroidTransportConfig, SocketConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { buildPairingQRData } from '../../Utils/companion-reg-client-utils'
import {
	assertValidNativeAndroidHardwareCatalog,
	CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES,
	createNativeAndroidDeviceProfile,
	EXPERIMENTAL_SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES,
	NATIVE_ANDROID_HARDWARE_CATALOG,
	shouldFallbackNativeAndroidProfile,
	VERIFIED_NATIVE_ANDROID_HARDWARE_PROFILES
} from '../../Utils/native-android-device-catalog'
import {
	appendNativeAndroidPairingAttestation,
	resolveTransportSession,
	validateNativeAndroidConfig
} from '../../Utils/native-android-transport'
import {
	createNativeAndroidClientPayloadContext,
	encodeNativeAndroidConnectionSequenceInfo,
	generateLoginNode,
	generateRegistrationNode,
	incrementNativeAndroidConnectionLc
} from '../../Utils/validate-connection'
import type { BinaryNode } from '../../WABinary'

const nativeAndroid: NativeAndroidTransportConfig = {
	enabled: true,
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
		clientAppId: 'fixture-client-app-id'
	}),
	device: {
		profileId: 'controlled-device-fixture',
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

const nativeConfig = (): SocketConfig => ({
	...DEFAULT_CONNECTION_CONFIG,
	transportProfile: 'native_android',
	nativeAndroid
})

const registrationContext = () =>
	createNativeAndroidClientPayloadContext({
		registered: false,
		connectionLc: 0,
		sessionId: 1
	})

describe('native_android transport contract', () => {
	it('ships a complete experimental catalog plus a captured generic fallback', () => {
		expect(() => assertValidNativeAndroidHardwareCatalog(NATIVE_ANDROID_HARDWARE_CATALOG)).not.toThrow()
		expect(EXPERIMENTAL_SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES).toHaveLength(21)
		expect(CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES).toHaveLength(1)
		const context = {
			mcc: '001',
			mnc: '01',
			localeLanguageIso6391: 'pt',
			localeCountryIso31661Alpha2: 'BR'
		}
		const first = createNativeAndroidDeviceProfile(context, undefined, () => 0)
		const second = createNativeAndroidDeviceProfile(context, undefined, () => 0)

		expect(first).toMatchObject(EXPERIMENTAL_SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES[0])
		expect(first.quality).toBe('experimental')
		expect(first.phoneId).toMatch(/^[0-9a-f-]{36}$/)
		expect(first.perfDeviceId).toMatch(/^[0-9a-f-]{36}$/)
		expect(first.deviceExpId).toMatch(/^[A-Za-z0-9_-]{22}$/)
		expect(first.deviceExpId).not.toContain('=')
		expect(first.phoneIdTimestamp).toEqual(expect.any(Number))
		expect(second.phoneId).not.toBe(first.phoneId)
		expect(second.perfDeviceId).not.toBe(first.perfDeviceId)
		expect(second.deviceExpId).not.toBe(first.deviceExpId)
	})

	it('rejects an empty or incomplete hardware catalog', () => {
		expect(() => assertValidNativeAndroidHardwareCatalog([])).toThrow('catalog is empty')
		expect(() =>
			assertValidNativeAndroidHardwareCatalog([{ ...VERIFIED_NATIVE_ANDROID_HARDWARE_PROFILES[0], deviceBoard: '' }])
		).toThrow('has no deviceBoard')
	})

	it('uses the generic fallback only for a pre-registration server rejection', () => {
		const profileId = EXPERIMENTAL_SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES[0].profileId
		expect(shouldFallbackNativeAndroidProfile({ registered: false, serverFailureReason: 400, profileId })).toBe(true)
		expect(shouldFallbackNativeAndroidProfile({ registered: false, serverFailureReason: 500, profileId })).toBe(false)
		expect(shouldFallbackNativeAndroidProfile({ registered: true, serverFailureReason: 400, profileId })).toBe(false)
		expect(
			shouldFallbackNativeAndroidProfile({
				registered: false,
				hasAccount: true,
				hasMe: true,
				serverFailureReason: 400,
				profileId
			})
		).toBe(false)
		expect(
			shouldFallbackNativeAndroidProfile({
				registered: false,
				serverFailureReason: 400,
				profileId: CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES[0].profileId
			})
		).toBe(false)
	})

	it('keeps the persisted catalog identity when a restart randomly proposes another catalog entry', () => {
		const context = {
			mcc: '001',
			mnc: '01',
			localeLanguageIso6391: 'pt',
			localeCountryIso31661Alpha2: 'BR'
		}
		const firstDevice = createNativeAndroidDeviceProfile(context, undefined, () => 0)
		const secondDevice = createNativeAndroidDeviceProfile(context, undefined, () => 1)
		const creds = initAuthCreds()
		const firstConfig = { ...nativeAndroid, device: firstDevice }
		const secondConfig = { ...nativeAndroid, device: secondDevice }

		resolveTransportSession({ ...nativeConfig(), nativeAndroid: firstConfig }, creds)
		const resolved = resolveTransportSession({ ...nativeConfig(), nativeAndroid: secondConfig }, creds)

		expect(resolved.nativeAndroid?.device).toEqual(firstDevice)
	})

	it('keeps Web as the stable default and preserves its QR payload', () => {
		expect(DEFAULT_CONNECTION_CONFIG.transportProfile).toBe('web')
		expect(buildPairingQRData('r', 'n', 'i', 'a', ['Mac OS', 'Chrome', '1'])).toBe('r,n,i,a')
	})

	it('uses the captured official WA Noise header rather than the WAM telemetry header', () => {
		expect(NOISE_WA_HEADER).toEqual(Buffer.from([0x57, 0x41, 0x06, 0x03]))
		expect(NOISE_WA_HEADER).not.toEqual(Buffer.from([0x57, 0x41, 0x4d, 0x05]))
	})

	it('uses the official linked-devices URL form for native QR', () => {
		expect(buildPairingQRData('r', 'n', 'i', 'a', ['Android', 'Mobile', '15'], 'native_android')).toBe(
			'https://wa.me/settings/linked_devices#r,n,i,a'
		)
	})

	it('builds SMB_ANDROID ClientPayload without WebInfo', () => {
		const node = generateRegistrationNode(initAuthCreds(), nativeConfig(), registrationContext())
		expect(node.userAgent?.platform).toBe(10)
		expect(node.userAgent?.appVersion).toMatchObject({ primary: 2, secondary: 26, tertiary: 27, quaternary: 83 })
		expect(node.userAgent?.manufacturer).toBe('fixture-manufacturer')
		expect(node.userAgent?.phoneId).toBe('fixture-phone-id')
		expect(node.userAgent?.deviceExpId).toBe('fixture-device-exp-id')
		expect(node.webInfo).toBeNull()
		expect(node.yearClass).toBe(2024)
		expect(node.memClass).toBe(8192)
		const companion = proto.DeviceProps.decode(node.devicePairingData?.deviceProps!)
		expect(companion.version).toMatchObject({ primary: 2, secondary: 26, tertiary: 27, quaternary: 83 })
		expect(companion.historySyncConfig).toMatchObject({
			supportCallLogHistory: true,
			supportBizHostedMsg: false,
			supportAddOnHistorySyncMigration: true,
			supportNewsletter: true
		})
		expect(Buffer.from(node.devicePairingData?.buildHash!)).toEqual(
			Buffer.from(createHash('md5').update('2.26.27.83').digest('hex'), 'base64')
		)
	})

	it('does not change the existing Web registration payload', () => {
		const node = generateRegistrationNode(initAuthCreds(), DEFAULT_CONNECTION_CONFIG)
		expect(node.userAgent?.platform).toBe(14)
		expect(node.webInfo).toBeDefined()
		expect(node.userAgent?.device).toBe('Desktop')
	})

	it('matches the captured official registered ClientPayload byte for byte', () => {
		const capturedDevice = {
			...CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES[0],
			phoneId: 'f739f7cd-378f-4ab1-b75f-cb1a475bd7f6',
			deviceExpId: 'h2bsnojkTEqdxWeCmFYNUg',
			mcc: '310',
			mnc: '260',
			localeLanguageIso6391: 'en',
			localeCountryIso31661Alpha2: 'US'
		}
		const config: SocketConfig = {
			...nativeConfig(),
			nativeAndroid: { ...nativeAndroid, device: capturedDevice }
		}
		const context = createNativeAndroidClientPayloadContext({
			registered: true,
			connectionLc: 11,
			port: 443,
			sequenceStep: 1,
			sessionId: 451263734,
			connectType: proto.ClientPayload.ConnectType.CELLULAR_HSPA,
			connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
			dnsMethod: proto.ClientPayload.DNSSource.DNSResolutionMethod.MNS,
			dnsAppCached: false,
			connectAttemptCount: 0
		})
		const encoded = proto.ClientPayload.encode(
			generateLoginNode('5515981907008:93@s.whatsapp.net', config, context)
		).finish()

		expect(Buffer.from(encoded).toString('hex')).toBe(
			'08c0c891d1c4a00118002aee01080a12080802101a181b20531a0333313022033236302a0231323206476f6f676c653a17656d756c61746f7236345f7838365f36345f61726d3634424273646b5f6770686f6e6536345f7838365f36342d75736572646562756720313220534531412e3232303832362e303038203130353634343538206465762d6b6579734a2466373339663763642d333738662d346162312d623735662d6362316134373562643766365a02656e620255536a0f676f6c64666973685f7838365f36347216683262736e6f6a6b54457164785765436d46594e5567780082011373646b5f6770686f6e6536345f7838365f36344df6bce51a5001606b68017a05780580010080010090015db80101c0010ba002e00fa802c001c00200c80201dd0285000000e00200'
		)
		expect(encoded).toHaveLength(304)
	})

	it('reproduces the official connection metadata lifecycle', () => {
		expect(encodeNativeAndroidConnectionSequenceInfo({ port: 443, sequenceStep: 1 })).toBe(133)
		expect(encodeNativeAndroidConnectionSequenceInfo({ port: 5222, sequenceStep: 1 })).toBe(134)
		expect(incrementNativeAndroidConnectionLc(11)).toBe(12)
		expect(incrementNativeAndroidConnectionLc(0x7fffffff)).toBe(0)
		expect(() => encodeNativeAndroidConnectionSequenceInfo({ port: 443, sequenceStep: 32 })).toThrow('range 0..31')
	})

	it('persists the complete profile once and refuses cross-protocol conversion', () => {
		const creds = initAuthCreds()
		const resolved = resolveTransportSession(nativeConfig(), creds)
		expect(resolved.credsChanged).toBe(true)
		expect(creds.nativeAndroidIdentity?.device).toEqual(nativeAndroid.device)

		expect(() => resolveTransportSession(nativeConfig(), creds)).not.toThrow()
		const regeneratedDynamicIds = {
			...nativeAndroid,
			device: {
				...nativeAndroid.device,
				phoneId: 'new-process-phone-id',
				deviceExpId: 'new-process-device-exp-id'
			}
		}
		expect(
			resolveTransportSession({ ...nativeConfig(), nativeAndroid: regeneratedDynamicIds }, creds).nativeAndroid?.device
		).toEqual(nativeAndroid.device)
		expect(() => resolveTransportSession({ ...DEFAULT_CONNECTION_CONFIG, transportProfile: 'web' }, creds)).toThrow(
			'native_android credentials cannot be opened by the Web transport'
		)

		const webCreds = { ...initAuthCreds(), registered: true }
		expect(() => resolveTransportSession(nativeConfig(), webCreds)).toThrow(
			'existing unmarked Web session cannot be converted automatically'
		)

		const legacyWebCreds = {
			...initAuthCreds(),
			registered: false,
			account: {},
			me: { id: '123@s.whatsapp.net', name: 'legacy-web' }
		}
		expect(() => resolveTransportSession(nativeConfig(), legacyWebCreds)).toThrow(
			'existing unmarked Web session cannot be converted automatically'
		)
		expect(legacyWebCreds.registered).toBe(false)
	})

	it('self-heals the registered marker for an already paired persisted native session', () => {
		const creds = initAuthCreds()
		resolveTransportSession(nativeConfig(), creds)
		creds.account = {}
		creds.me = { id: '123@lid', name: 'fixture' }
		creds.registered = false

		const resolved = resolveTransportSession(nativeConfig(), creds)

		expect(creds.registered).toBe(true)
		expect(resolved.credsChanged).toBe(true)
		expect(resolved.nativeAndroid?.device).toEqual(nativeAndroid.device)
	})

	it('does not infer registration or mutate an unpaired native identity', () => {
		const creds = initAuthCreds()
		resolveTransportSession(nativeConfig(), creds)

		const resolved = resolveTransportSession(nativeConfig(), creds)

		expect(creds.registered).toBe(false)
		expect(resolved.credsChanged).toBe(false)
	})

	it('rejects incomplete device identities and mismatched persisted profiles', () => {
		expect(() =>
			validateNativeAndroidConfig({
				...nativeAndroid,
				device: { ...nativeAndroid.device, phoneId: '' }
			})
		).toThrow('phoneId is required')

		const creds = initAuthCreds()
		resolveTransportSession(nativeConfig(), creds)
		expect(() =>
			resolveTransportSession(
				{
					...nativeConfig(),
					nativeAndroid: { ...nativeAndroid, device: { ...nativeAndroid.device, profileId: 'different' } }
				},
				creds
			)
		).toThrow('does not match persisted profile')
	})

	it('fails before QR when a fresh native session has no genuine attestation provider', () => {
		expect(() =>
			resolveTransportSession(
				{ ...nativeConfig(), nativeAndroid: { ...nativeAndroid, attestationProvider: undefined } },
				initAuthCreds()
			)
		).toThrow('attestationProvider is required before starting a fresh QR pairing')
	})

	it('adds only provider-supplied attestation artifacts to pair-device-sign', () => {
		const reply: BinaryNode = {
			tag: 'iq',
			attrs: {},
			content: [{ tag: 'pair-device-sign', attrs: {}, content: [] }]
		}
		appendNativeAndroidPairingAttestation(reply, {
			keyAttestation: Buffer.from([1]),
			gpia: Buffer.alloc(0)
		})
		const pairSign = (reply.content as BinaryNode[])[0]!
		expect((pairSign.content as BinaryNode[]).map(node => node.tag)).toEqual(['key_attestation', 'gpia'])

		const extendedReply: BinaryNode = {
			tag: 'iq',
			attrs: {},
			content: [{ tag: 'pair-device-sign', attrs: {}, content: [] }]
		}
		appendNativeAndroidPairingAttestation(extendedReply, {
			keyAttestation: Buffer.from([1]),
			gpia: Buffer.alloc(0),
			clientAppId: 'fixture-client-app-id'
		})
		const extendedPairSign = (extendedReply.content as BinaryNode[])[0]!
		expect((extendedPairSign.content as BinaryNode[]).map(node => node.tag)).toEqual([
			'key_attestation',
			'gpia',
			'client-app-id'
		])
	})
})

describe('TcpSocketClient', () => {
	it('carries arbitrary binary chunks without WebSocket framing', async () => {
		const server = net.createServer(socket => {
			socket.once('data', data => socket.write(Buffer.concat([Buffer.from([0xaa]), data])))
		})
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')

		const client = new TcpSocketClient(new URL(`tcp://127.0.0.1:${address.port}`), nativeConfig())
		try {
			const received = new Promise<Buffer>((resolve, reject) => {
				client.once('message', resolve)
				client.once('error', reject)
			})
			await new Promise<void>((resolve, reject) => {
				client.once('open', resolve)
				client.once('error', reject)
				client.connect()
			})
			client.send(Buffer.from([1, 2, 3]))
			expect(await received).toEqual(Buffer.from([0xaa, 1, 2, 3]))
		} finally {
			await client.close()
			await new Promise<void>(resolve => server.close(() => resolve()))
		}
	})
})
