import { jest } from '@jest/globals'
import { createHash } from 'crypto'
import net from 'net'
import { proto } from '../../../WAProto/index.js'
import {
	DEFAULT_CONNECTION_CONFIG,
	NOISE_WA_HEADER,
	WABA_CLIENT_APP_ID,
	WHATSAPP_MESSENGER_CLIENT_APP_ID
} from '../../Defaults'
import { TcpSocketClient } from '../../Socket/Client'
import type { NativeAndroidTransportConfig, SocketConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { buildPairingQRData } from '../../Utils/companion-reg-client-utils'
import {
	assertValidNativeAndroidHardwareCatalog,
	CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES,
	createNativeAndroidDeviceProfile,
	NATIVE_ANDROID_HARDWARE_CATALOG,
	SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES,
	shouldFallbackNativeAndroidProfile,
	VERIFIED_NATIVE_ANDROID_HARDWARE_PROFILES
} from '../../Utils/native-android-device-catalog'
import {
	appendNativeAndroidPairingAttestation,
	detectNativeAndroidAppVariant,
	resolveNativeAndroidPairingAppVariant,
	resolveTransportSession,
	validateNativeAndroidConfig
} from '../../Utils/native-android-transport'
import {
	createNativeAndroidClientPayloadContext,
	encodeNativeAndroidConnectionSequenceInfo,
	generateLoginNode,
	generateRegistrationNode,
	incrementNativeAndroidConnectionLc,
	resolveNativeAndroidClientPayloadPhase
} from '../../Utils/validate-connection'
import type { BinaryNode } from '../../WABinary'

const nativeAndroid: NativeAndroidTransportConfig = {
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
		phase: 'registration',
		connectionLc: 0,
		sessionId: 1
	})

const freshCaptureHex =
	'18002aee01080a12080802101a181b20531a0333313022033236302a0231323206476f6f676c653a17656d756c61746f7236345f7838365f36345f61726d3634424273646b5f6770686f6e6536345f7838365f36342d75736572646562756720313220534531412e3232303832362e303038203130353634343538206465762d6b6579734a2430653238386663642d623530362d346564332d393230312d3966613663323939643231335a02656e620255536a0f676f6c64666973685f7838365f363472163849685866756739536a6148316f704d3846615a3677780082011373646b5f6770686f6e6536345f7838365f36344daf06e1c45001606b68067a0578008001018001009a0187020a045187da0f1201051a203783812c369259712c7c30fc6386d39792bf80f6ebce9facfbce0fa0296c275b22035d5c982a20d9924c4f087ce88707f4764912308e864ffbd606d61658e37176c9c80b7f223b32401c5721fc9ffca9eef4f4537e62cdfd55da030178c4247b789bc4a7fbc744c37cdb5b4aac1b532bd19bc754b839b45b13013cb3cb0d3b912351a04533da07090b3a1873cddfe39dddf1de357b477ce3befde386f8e5f7f7d38ebb42570a02313212080802101a181b2053181120012a4308ed0210322001280030013801400148005801600168017001780180010188010090010098015aa80101b00100ba011031383037303535393436363437363936c80101b80101c00100a002e00fa802c001c00200dd0285000000e00200'

const initialPairLoginCaptureHex =
	'08c0c891d1c4a00118012aee01080a12080802101a181b20531a0333313022033236302a0231323206476f6f676c653a17656d756c61746f7236345f7838365f36345f61726d3634424273646b5f6770686f6e6536345f7838365f36342d75736572646562756720313220534531412e3232303832362e303038203130353634343538206465762d6b6579734a2430653238386663642d623530362d346564332d393230312d3966613663323939643231335a02656e620255536a0f676f6c64666973685f7838365f363472163849685866756739536a6148316f704d3846615a3677780082011373646b5f6770686f6e6536345f7838365f36344d0b6c65a55001606b68067a057800800101800100900160b80101c00100a002e00fa802c001c00200dd0286000000e00200'

const capturedFreshConfig = (): SocketConfig => ({
	...nativeConfig(),
	syncFullHistory: true,
	nativeAndroid: {
		...nativeAndroid,
		historySync: {
			fullSyncDaysLimit: 365,
			fullSyncSizeMbLimit: 50,
			thumbnailSyncDaysLimit: 90,
			supportGroupHistory: true,
			onDemandReady: true,
			supportHatchHistory: false,
			supportedBotChannelFbids: ['1807055946647696']
		},
		device: {
			...CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES[0],
			phoneId: '0e288fcd-b506-4ed3-9201-9fa6c299d213',
			deviceExpId: '8IhXfug9SjaH1opM8FaZ6w',
			mcc: '310',
			mnc: '260',
			localeLanguageIso6391: 'en',
			localeCountryIso31661Alpha2: 'US'
		}
	}
})

describe('native_android transport contract', () => {
	it('selects the captured registration, first-login and reconnect payload phases', () => {
		expect(resolveNativeAndroidClientPayloadPhase({ hasRegisteredIdentity: false })).toBe('registration')
		expect(
			resolveNativeAndroidClientPayloadPhase({
				hasRegisteredIdentity: true,
				accountSyncCounter: 0
			})
		).toBe('initial_pair_login')
		expect(
			resolveNativeAndroidClientPayloadPhase({
				hasRegisteredIdentity: true,
				accountSyncCounter: 1
			})
		).toBe('reconnect')
	})

	it('ships a complete supported catalog plus a captured generic fallback', () => {
		expect(() => assertValidNativeAndroidHardwareCatalog(NATIVE_ANDROID_HARDWARE_CATALOG)).not.toThrow()
		expect(SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES).toHaveLength(21)
		expect(CAPTURED_NATIVE_ANDROID_HARDWARE_PROFILES).toHaveLength(1)
		const context = {
			mcc: '001',
			mnc: '01',
			localeLanguageIso6391: 'pt',
			localeCountryIso31661Alpha2: 'BR'
		}
		const first = createNativeAndroidDeviceProfile(context, undefined, () => 0)
		const second = createNativeAndroidDeviceProfile(context, undefined, () => 0)

		expect(first).toMatchObject(SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES[0])
		expect(first.quality).toBe('catalog')
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
		const profileId = SAMSUNG_NATIVE_ANDROID_HARDWARE_PROFILES[0].profileId
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
		expect(Buffer.from(node.devicePairingData?.buildHash!)).toHaveLength(24)
	})

	it('builds the Consumer ClientPayload with its own platform and version', () => {
		const config: SocketConfig = {
			...nativeConfig(),
			nativeAndroid: {
				...nativeAndroid,
				appVariant: 'consumer',
				appVersion: [2, 26, 29, 5]
			}
		}
		const node = generateRegistrationNode(initAuthCreds(), config, registrationContext())

		expect(node.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.ANDROID)
		expect(node.userAgent?.appVersion).toMatchObject({
			primary: 2,
			secondary: 26,
			tertiary: 29,
			quaternary: 5
		})
		expect(node.webInfo).toBeNull()
	})

	it('matches the captured official fresh-registration ClientPayload byte for byte', () => {
		const captured = proto.ClientPayload.decode(Buffer.from(freshCaptureHex, 'hex'))
		const pairing = captured.devicePairingData!
		const creds = {
			registrationId: Buffer.from(pairing.eRegid!).readUInt32BE(),
			signedIdentityKey: {
				public: pairing.eIdent!,
				private: Buffer.alloc(32)
			},
			signedPreKey: {
				keyId: Buffer.from(pairing.eSkeyId!).readUIntBE(0, 3),
				keyPair: {
					public: pairing.eSkeyVal!,
					private: Buffer.alloc(32)
				},
				signature: pairing.eSkeySig!
			}
		}
		const context = createNativeAndroidClientPayloadContext({
			phase: 'registration',
			connectionLc: 0,
			port: 443,
			sequenceStep: 1,
			sessionId: -991885649
		})
		const encoded = proto.ClientPayload.encode(generateRegistrationNode(creds, capturedFreshConfig(), context)).finish()
		const companion = proto.DeviceProps.decode(pairing.deviceProps!)

		expect(companion.platformType).toBe(proto.DeviceProps.PlatformType.ANDROID_AMBIGUOUS)
		expect(companion.historySyncConfig?.recentSyncDaysLimit).toBe(0)
		expect(Buffer.from(encoded).toString('hex')).toBe(freshCaptureHex)
		expect(encoded).toHaveLength(557)
	})

	it('matches the captured official first login after QR byte for byte', () => {
		const context = createNativeAndroidClientPayloadContext({
			phase: 'initial_pair_login',
			connectionLc: 0,
			port: 5222,
			sequenceStep: 1,
			sessionId: -1520079861
		})
		const encoded = proto.ClientPayload.encode(
			generateLoginNode('5515981907008:96@s.whatsapp.net', capturedFreshConfig(), context)
		).finish()

		expect(Buffer.from(encoded).toString('hex')).toBe(initialPairLoginCaptureHex)
		expect(encoded).toHaveLength(301)
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
			phase: 'reconnect',
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
				appVersion: undefined as unknown as NativeAndroidTransportConfig['appVersion']
			})
		).toThrow('appVersion must contain the four official Android components')
		expect(() =>
			validateNativeAndroidConfig({
				...nativeAndroid,
				device: undefined as unknown as NativeAndroidTransportConfig['device']
			})
		).toThrow('a complete device profile is required')
		expect(() =>
			validateNativeAndroidConfig({
				...nativeAndroid,
				device: { ...nativeAndroid.device, phoneId: '' }
			})
		).toThrow('phoneId is required')
		expect(() =>
			validateNativeAndroidConfig({
				...nativeAndroid,
				appVersions: 42 as unknown as NativeAndroidTransportConfig['appVersions']
			})
		).toThrow('appVersions must be an object')
		expect(() =>
			validateNativeAndroidConfig({
				...nativeAndroid,
				initialRoutingInfo: 'not-bytes' as unknown as Uint8Array
			})
		).toThrow('initialRoutingInfo must be bytes')

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

	it('uses the built-in Node provider when a fresh native session has no custom provider', () => {
		const resolved = resolveTransportSession(
			{ ...nativeConfig(), nativeAndroid: { ...nativeAndroid, attestationProvider: undefined } },
			initAuthCreds()
		)
		expect(resolved.nativeAndroid?.attestationProvider).toBeInstanceOf(Function)
	})

	it('detects the primary app at pair-success and persists an automatic Consumer fallback', () => {
		expect(detectNativeAndroidAppVariant('smba')).toBe('business')
		expect(detectNativeAndroidAppVariant('smbi')).toBe('business')
		expect(detectNativeAndroidAppVariant('android')).toBe('consumer')
		expect(detectNativeAndroidAppVariant('iphone')).toBe('consumer')
		expect(detectNativeAndroidAppVariant('unknown')).toBeUndefined()

		const creds = initAuthCreds()
		const config: NativeAndroidTransportConfig = {
			...nativeAndroid,
			appVariant: 'business',
			autoDetectAppVariant: true,
			appVersions: {
				business: [2, 26, 27, 83],
				consumer: [2, 26, 29, 5]
			}
		}
		resolveTransportSession({ ...nativeConfig(), nativeAndroid: config }, creds)

		const resolution = resolveNativeAndroidPairingAppVariant(config, creds, 'android')

		expect(resolution).toMatchObject({
			variant: 'consumer',
			fallbackApplied: true,
			detected: true
		})
		expect(config.appVersion).toEqual([2, 26, 29, 5])
		expect(creds.nativeAndroidIdentity).toMatchObject({
			appVariant: 'consumer',
			clientAppId: WHATSAPP_MESSENGER_CLIENT_APP_ID,
			appVersion: [2, 26, 29, 5]
		})
	})

	it('never guesses an app variant or changes a registered session silently', () => {
		const autoCreds = initAuthCreds()
		const autoConfig: NativeAndroidTransportConfig = {
			...nativeAndroid,
			autoDetectAppVariant: true,
			appVersions: {
				business: [2, 26, 27, 83],
				consumer: [2, 26, 29, 5]
			}
		}
		resolveTransportSession({ ...nativeConfig(), nativeAndroid: autoConfig }, autoCreds)
		expect(() => resolveNativeAndroidPairingAppVariant(autoConfig, autoCreds, undefined)).toThrow('refusing to guess')

		const explicitCreds = initAuthCreds()
		resolveTransportSession(nativeConfig(), explicitCreds)
		expect(() => resolveNativeAndroidPairingAppVariant(nativeAndroid, explicitCreds, 'android')).toThrow(
			'configured as business'
		)

		const registeredCreds = initAuthCreds()
		resolveTransportSession(nativeConfig(), registeredCreds)
		registeredCreds.registered = true
		expect(() => resolveNativeAndroidPairingAppVariant(nativeAndroid, registeredCreds, 'android')).toThrow(
			'cannot be changed after registration'
		)
		expect(registeredCreds.nativeAndroidIdentity?.appVariant).toBe('business')
	})

	it('allows only an unregistered attempt to issue a fresh QR with the alternative app', () => {
		const creds = initAuthCreds()
		resolveTransportSession(nativeConfig(), creds)

		const consumerConfig: NativeAndroidTransportConfig = {
			...nativeAndroid,
			appVariant: 'consumer',
			appVersion: [2, 26, 29, 5]
		}
		const retry = resolveTransportSession({ ...nativeConfig(), nativeAndroid: consumerConfig }, creds)

		expect(retry.credsChanged).toBe(true)
		expect(retry.nativeAndroid?.appVariant).toBe('consumer')
		expect(creds.nativeAndroidIdentity).toMatchObject({
			appVariant: 'consumer',
			clientAppId: WHATSAPP_MESSENGER_CLIENT_APP_ID
		})

		creds.registered = true
		creds.account = {}
		creds.me = { id: '123@s.whatsapp.net', name: 'registered-consumer' }
		const reconnect = resolveTransportSession(
			{
				...nativeConfig(),
				nativeAndroid: {
					...nativeAndroid,
					appVersions: {
						business: [2, 26, 27, 83],
						consumer: [2, 26, 29, 5]
					}
				}
			},
			creds
		)
		expect(reconnect.nativeAndroid?.appVariant).toBe('consumer')
		expect(reconnect.nativeAndroid?.appVersion).toEqual([2, 26, 29, 5])
		expect(creds.nativeAndroidIdentity?.appVariant).toBe('consumer')
		expect(creds.nativeAndroidIdentity?.appVersion).toEqual([2, 26, 29, 5])
	})

	it('migrates a registered pre-variant native session to Business without rotating it', () => {
		const creds = initAuthCreds()
		resolveTransportSession(nativeConfig(), creds)
		creds.registered = true
		creds.account = {}
		creds.me = { id: '123@s.whatsapp.net', name: 'legacy-native' }
		delete creds.nativeAndroidIdentity!.appVariant
		delete creds.nativeAndroidIdentity!.clientAppId

		const resolved = resolveTransportSession(nativeConfig(), creds)

		expect(resolved.credsChanged).toBe(true)
		expect(creds.nativeAndroidIdentity).toMatchObject({
			appVariant: 'business',
			clientAppId: WABA_CLIENT_APP_ID
		})
	})

	it('adds only provider-supplied attestation artifacts to pair-device-sign', () => {
		const reply: BinaryNode = {
			tag: 'iq',
			attrs: {},
			content: [
				{
					tag: 'pair-device-sign',
					attrs: {},
					content: [{ tag: 'device-identity', attrs: { 'key-index': '1' }, content: Buffer.from([0]) }]
				}
			]
		}
		appendNativeAndroidPairingAttestation(reply, {
			keyAttestation: Buffer.alloc(2039, 1),
			gpia: Buffer.alloc(0),
			clientAppId: WABA_CLIENT_APP_ID
		})
		const pairSign = (reply.content as BinaryNode[])[0]!
		const children = pairSign.content as BinaryNode[]
		expect(children.map(node => node.tag)).toEqual(['device-identity', 'key_attestation', 'gpia', 'client-app-id'])
		expect(Buffer.from(children[1]!.content as Uint8Array)).toHaveLength(2039)
		expect(Buffer.from(children[2]!.content as Uint8Array)).toHaveLength(0)
		expect(children[3]!.content).toBe(WABA_CLIENT_APP_ID)

		const invalidReply: BinaryNode = {
			tag: 'iq',
			attrs: {},
			content: [{ tag: 'pair-device-sign', attrs: {}, content: [] }]
		}
		expect(() =>
			appendNativeAndroidPairingAttestation(invalidReply, {
				keyAttestation: Buffer.from([1]),
				gpia: Buffer.alloc(0),
				clientAppId: ''
			})
		).toThrow('unexpected client-app-id')
	})

	it('writes the Messenger client-app-id only for a validated Consumer pairing', () => {
		const reply: BinaryNode = {
			tag: 'iq',
			attrs: {},
			content: [{ tag: 'pair-device-sign', attrs: {}, content: [] }]
		}
		appendNativeAndroidPairingAttestation(
			reply,
			{
				keyAttestation: Buffer.from([1]),
				gpia: Buffer.alloc(0),
				clientAppId: WHATSAPP_MESSENGER_CLIENT_APP_ID
			},
			WHATSAPP_MESSENGER_CLIENT_APP_ID
		)
		const children = ((reply.content as BinaryNode[])[0]!.content || []) as BinaryNode[]
		expect(children.at(-1)).toMatchObject({
			tag: 'client-app-id',
			content: WHATSAPP_MESSENGER_CLIENT_APP_ID
		})
	})
})

describe('TcpSocketClient', () => {
	it('propagates asynchronous socket write errors to the send callback', () => {
		const client = new TcpSocketClient(new URL('tcp://127.0.0.1:443'), nativeConfig())
		const writeError = new Error('forced async write failure')
		;(client as unknown as { state: string }).state = 'open'
		;(client as unknown as { socket: { destroyed: boolean; write: Function } }).socket = {
			destroyed: false,
			write: (_data: Uint8Array | string, callback: (error?: Error) => void) => {
				callback(writeError)
				return true
			}
		}
		const callback = jest.fn()

		expect(client.send(Buffer.from([1]), callback)).toBe(true)
		expect(callback).toHaveBeenCalledWith(writeError)
	})

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
