import { Boom } from '@hapi/boom'
import { createHash, randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import {
	KEY_BUNDLE_TYPE,
	WA_ADV_ACCOUNT_SIG_PREFIX,
	WA_ADV_DEVICE_SIG_PREFIX,
	WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
} from '../Defaults'
import type { AuthenticationCreds, SignalCreds, SocketConfig } from '../Types'
import { type BinaryNode, getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary'
import { Curve, hmacSign } from './crypto'
import { encodeBigEndian } from './generics'
import { createSignalIdentity } from './signal'

export type NativeAndroidClientPayloadContext = {
	phase: 'registration' | 'initial_pair_login' | 'reconnect'
	sessionId: number
	passive: boolean
	shortConnect: boolean
	connectType: proto.ClientPayload.ConnectType
	connectReason: proto.ClientPayload.ConnectReason
	dnsMethod: proto.ClientPayload.DNSSource.DNSResolutionMethod
	dnsAppCached: boolean
	connectAttemptCount: number
	connectionSequenceInfo: number
	connectionLc: number
	trafficAnonymization: proto.ClientPayload.TrafficAnonymization
	lidDbMigrated?: boolean
	paaLink: boolean
}

type NativeAndroidClientPayloadContextOptions = {
	phase: NativeAndroidClientPayloadContext['phase']
	connectionLc?: number
	port?: number
	sequenceStep?: number
	sessionId?: number
	connectType?: proto.ClientPayload.ConnectType
	connectReason?: proto.ClientPayload.ConnectReason
	dnsMethod?: proto.ClientPayload.DNSSource.DNSResolutionMethod
	dnsAppCached?: boolean
	connectAttemptCount?: number
}

export const resolveNativeAndroidClientPayloadPhase = ({
	hasRegisteredIdentity,
	accountSyncCounter
}: {
	hasRegisteredIdentity: boolean
	accountSyncCounter?: number
}): NativeAndroidClientPayloadContext['phase'] =>
	!hasRegisteredIdentity ? 'registration' : (accountSyncCounter ?? 0) === 0 ? 'initial_pair_login' : 'reconnect'

const nativeAndroidSessionId = () => randomBytes(4).readInt32BE(0)

/**
 * Encodes the connection metadata bit-field used by the official Android
 * ClientPayload provider:
 *   bits 0..1  destination port (80=0, 443=1, 5222=2, other=3)
 *   bits 2..4  address-selection source
 *   bit 5      proxy-directness flag
 *   bits 7..11 connection sequence step
 *   bit 12     cached Wi-Fi capability
 *
 * The direct MNS path captured from WABA uses address source 1, no proxy and
 * no cached-Wi-Fi bit. Keeping the encoder explicit prevents the observed 133
 * from becoming an unexplained magic constant.
 */
export const encodeNativeAndroidConnectionSequenceInfo = ({
	port,
	sequenceStep,
	addressSource = 1,
	proxyDirectness = 0,
	cachedWifiCapability = false
}: {
	port: number
	sequenceStep: number
	addressSource?: number
	proxyDirectness?: 0 | 1
	cachedWifiCapability?: boolean
}) => {
	if (!Number.isInteger(sequenceStep) || sequenceStep < 0 || sequenceStep > 31) {
		throw new Boom(`native_android: connection sequence step must be in range 0..31, got ${sequenceStep}`, {
			statusCode: 400
		})
	}

	if (!Number.isInteger(addressSource) || addressSource < 0 || addressSource > 7) {
		throw new Boom(`native_android: address source must be in range 0..7, got ${addressSource}`, {
			statusCode: 400
		})
	}

	const portCode = port === 80 ? 0 : port === 443 ? 1 : port === 5222 ? 2 : 3
	return (
		portCode |
		(addressSource << 2) |
		(proxyDirectness << 5) |
		(sequenceStep << 7) |
		(cachedWifiCapability ? 1 << 12 : 0)
	)
}

export const createNativeAndroidClientPayloadContext = (
	options: NativeAndroidClientPayloadContextOptions
): NativeAndroidClientPayloadContext => {
	const port = options.port ?? 443
	const sequenceStep = options.sequenceStep ?? 1
	const connectionLc = options.connectionLc ?? 0
	if (!Number.isSafeInteger(connectionLc) || connectionLc < 0 || connectionLc > 0x7fffffff) {
		throw new Boom(`native_android: connection lc is invalid: ${connectionLc}`, { statusCode: 400 })
	}

	const isReconnect = options.phase === 'reconnect'
	const isInitialPairLogin = options.phase === 'initial_pair_login'

	return {
		phase: options.phase,
		sessionId: options.sessionId ?? nativeAndroidSessionId(),
		passive: isInitialPairLogin,
		shortConnect: true,
		connectType: options.connectType ?? proto.ClientPayload.ConnectType.CELLULAR_HSPA,
		connectReason:
			options.connectReason ??
			(isReconnect ? proto.ClientPayload.ConnectReason.USER_ACTIVATED : proto.ClientPayload.ConnectReason.UNKNOWN),
		dnsMethod:
			options.dnsMethod ??
			(isReconnect
				? proto.ClientPayload.DNSSource.DNSResolutionMethod.MNS
				: proto.ClientPayload.DNSSource.DNSResolutionMethod.SYSTEM),
		dnsAppCached: options.dnsAppCached ?? !isReconnect,
		connectAttemptCount: options.connectAttemptCount ?? 0,
		connectionSequenceInfo: encodeNativeAndroidConnectionSequenceInfo({ port, sequenceStep }),
		connectionLc,
		trafficAnonymization: proto.ClientPayload.TrafficAnonymization.OFF,
		lidDbMigrated: isReconnect ? true : undefined,
		paaLink: false
	}
}

export const incrementNativeAndroidConnectionLc = (current: number) => (current === 0x7fffffff ? 0 : current + 1)

// Web compatibility path. Native Android is intentionally handled separately
// below so changing transport profile cannot alter existing Web sessions.
// Equivalent territory: upstream PR WhiskeySockets/Baileys#2201 ("add android
// browser, can receive viewonce") flipped `platform` to ANDROID / dropped
// WebInfo to make the companion show up as Android. We cover the same
// outcome WITHOUT breaking the WA\x06\x03 (web) handshake: keep
// `platform: WEB` here (server-side requirement — ANDROID/SMB_ANDROID lets
// pair-code connect but fails at registration), keep WebInfo, and route the
// "appears as Android" part through DeviceProps on the registration node.
// in the registration node below. Validated in production: pair code works
// and the device shows up as "Android (14)" in Linked Devices.
const getUserAgent = (config: SocketConfig): proto.ClientPayload.IUserAgent => {
	if (config.transportProfile === 'native_android') {
		const native = config.nativeAndroid
		if (!native) {
			throw new Boom('native_android: configuration is required before building ClientPayload', {
				statusCode: 400
			})
		}

		const [primary, secondary, tertiary, quaternary] = native.appVersion
		const device = native.device
		return {
			appVersion: { primary, secondary, tertiary, quaternary },
			platform:
				native.appVariant === 'consumer'
					? proto.ClientPayload.UserAgent.Platform.ANDROID
					: proto.ClientPayload.UserAgent.Platform.SMB_ANDROID,
			mcc: device.mcc,
			mnc: device.mnc,
			osVersion: device.osVersion,
			manufacturer: device.manufacturer,
			device: device.device,
			osBuildNumber: device.osBuildNumber,
			phoneId: device.phoneId,
			localeLanguageIso6391: device.localeLanguageIso6391,
			localeCountryIso31661Alpha2: device.localeCountryIso31661Alpha2,
			deviceBoard: device.deviceBoard,
			deviceExpId: device.deviceExpId,
			deviceType: proto.ClientPayload.UserAgent.DeviceType.PHONE,
			deviceModelType: device.deviceModelType
		}
	}

	return {
		appVersion: {
			primary: config.version[0],
			secondary: config.version[1],
			tertiary: config.version[2]
		},
		platform: proto.ClientPayload.UserAgent.Platform.WEB,
		releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
		osVersion: '0.1',
		device: 'Desktop',
		osBuildNumber: '0.1',
		localeLanguageIso6391: 'en',

		mnc: '000',
		mcc: '000',
		localeCountryIso31661Alpha2: config.countryCode
	}
}

const PLATFORM_MAP = {
	'mac os': proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
	windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN32
}

export const buildWebInfo = (config: SocketConfig): proto.ClientPayload.IWebInfo => {
	let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
	const normalizedOs = config.browser[0].trim().toLowerCase()
	const normalizedBrowser = config.browser[1].trim().toLowerCase()
	if (config.syncFullHistory && normalizedOs === 'windows') {
		webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID
	} else if (config.syncFullHistory && normalizedBrowser === 'desktop') {
		webSubPlatform = PLATFORM_MAP[normalizedOs as keyof typeof PLATFORM_MAP] || webSubPlatform
	}

	return { webSubPlatform }
}

const getClientPayload = (config: SocketConfig, nativeContext?: NativeAndroidClientPayloadContext) => {
	const payload: proto.IClientPayload = {
		connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: getUserAgent(config)
	}

	if (config.transportProfile !== 'native_android') {
		payload.webInfo = buildWebInfo(config)
	} else {
		if (!nativeContext) {
			throw new Boom('native_android: connection payload context is required', { statusCode: 500 })
		}

		payload.sessionId = nativeContext.sessionId
		payload.shortConnect = nativeContext.shortConnect
		payload.connectType = nativeContext.connectType
		payload.connectReason = nativeContext.connectReason
		payload.dnsSource = {
			dnsMethod: nativeContext.dnsMethod,
			appCached: nativeContext.dnsAppCached
		}
		payload.connectAttemptCount = nativeContext.connectAttemptCount
		payload.connectionSequenceInfo = nativeContext.connectionSequenceInfo
		payload.lc = nativeContext.connectionLc
		payload.trafficAnonymization = nativeContext.trafficAnonymization
		if (nativeContext.lidDbMigrated !== undefined) {
			payload.lidDbMigrated = nativeContext.lidDbMigrated
		}

		payload.paaLink = nativeContext.paaLink
		payload.oc = config.nativeAndroid?.device.oc
		payload.yearClass = config.nativeAndroid?.device.yearClass
		payload.memClass = config.nativeAndroid?.device.memClass
	}

	// Upstream #2432: expose pushName for mock-phone harness deterministic assignment.
	if (config.pushName) {
		payload.pushName = config.pushName
	}

	return payload
}

export const generateLoginNode = (
	userJid: string,
	config: SocketConfig,
	nativeContext?: NativeAndroidClientPayloadContext
): proto.IClientPayload => {
	const { user, device } = jidDecode(userJid)!
	const payload: proto.IClientPayload =
		config.transportProfile === 'native_android'
			? {
					...getClientPayload(config, nativeContext),
					passive: nativeContext!.passive,
					username: +user,
					device: device
				}
			: {
					...getClientPayload(config),
					passive: true,
					pull: true,
					username: +user,
					device: device,
					// Web compatibility: preserve the historical Baileys value.
					lidDbMigrated: false
				}
	return proto.ClientPayload.fromObject(payload)
}

const getPlatformType = (platform: string): proto.DeviceProps.PlatformType => {
	const platformType = platform.toUpperCase()
	return (
		proto.DeviceProps.PlatformType[platformType as keyof typeof proto.DeviceProps.PlatformType] ||
		proto.DeviceProps.PlatformType.CHROME
	)
}

/**
 * The `DeviceProps` this client declares to the server during pairing — os /
 * platform type / requireFullSync + the full history-sync capability set.
 * Exported so the `companion_devices.db` mirror can persist EXACTLY what was
 * sent (single source of truth — no drift between the wire payload and the
 * mirrored row).
 */
export const buildCompanionDeviceProps = (config: SocketConfig): proto.IDeviceProps => {
	const isNativeAndroid = config.transportProfile === 'native_android'
	const isWindowsCompanion =
		!isNativeAndroid && config.syncFullHistory && config.browser[0].trim().toLowerCase() === 'windows'
	const webHistorySyncConfig: proto.DeviceProps.IHistorySyncConfig = isWindowsCompanion
		? {
				// Captured from the official WhatsApp Windows Beta (UWP) client.
				// Full-history mode is a two-stage sync: the initial payload makes
				// chats usable quickly, then on-demand chunks continue in the
				// background (and can pause/resume while waiting for the phone).
				fullSyncDaysLimit: 365,
				inlineInitialPayloadInE2EeMsg: true,
				supportCallLogHistory: true,
				supportBotUserAgentChatHistory: true,
				supportCagReactionsAndPolls: true,
				supportBizHostedMsg: true,
				supportRecentSyncChunkMessageCountTuning: true,
				supportHostedGroupMsg: true,
				supportFbidBotChatHistory: true,
				supportMessageAssociation: true,
				supportGroupHistory: true,
				onDemandReady: true,
				completeOnDemandReady: true,
				thumbnailSyncDaysLimit: 60,
				supportManusHistory: true,
				supportHatchHistory: true,
				supportedBotChannelFbids: []
			}
		: {
				// Preserve the pre-existing reduced-history profile for consumers
				// that explicitly opt out via syncFullHistory=false.
				storageQuotaMb: 10240,
				inlineInitialPayloadInE2EeMsg: true,
				recentSyncDaysLimit: undefined,
				supportCallLogHistory: false,
				supportBotUserAgentChatHistory: true,
				supportCagReactionsAndPolls: true,
				supportBizHostedMsg: true,
				supportRecentSyncChunkMessageCountTuning: true,
				supportHostedGroupMsg: true,
				supportFbidBotChatHistory: true,
				supportAddOnHistorySyncMigration: undefined,
				supportMessageAssociation: true,
				supportGroupHistory: false,
				onDemandReady: undefined,
				supportGuestChat: undefined
			}

	return {
		os: isNativeAndroid ? config.nativeAndroid?.device.osVersion : config.browser[0],
		platformType: isNativeAndroid
			? proto.DeviceProps.PlatformType.ANDROID_AMBIGUOUS
			: isWindowsCompanion
				? proto.DeviceProps.PlatformType.UWP
				: getPlatformType(config.browser[1]),
		requireFullSync: config.syncFullHistory,
		historySyncConfig: isNativeAndroid
			? {
					fullSyncDaysLimit: config.nativeAndroid!.historySync.fullSyncDaysLimit,
					fullSyncSizeMbLimit: config.nativeAndroid!.historySync.fullSyncSizeMbLimit,
					inlineInitialPayloadInE2EeMsg: true,
					recentSyncDaysLimit: 0,
					supportCallLogHistory: true,
					supportBotUserAgentChatHistory: true,
					supportCagReactionsAndPolls: true,
					supportBizHostedMsg: false,
					supportHostedGroupMsg: true,
					supportFbidBotChatHistory: true,
					supportAddOnHistorySyncMigration: true,
					supportMessageAssociation: true,
					supportGroupHistory: config.nativeAndroid!.historySync.supportGroupHistory,
					onDemandReady: config.nativeAndroid!.historySync.onDemandReady,
					supportGuestChat: false,
					completeOnDemandReady: false,
					thumbnailSyncDaysLimit: config.nativeAndroid!.historySync.thumbnailSyncDaysLimit,
					supportManusHistory: true,
					supportHatchHistory: config.nativeAndroid!.historySync.supportHatchHistory,
					supportedBotChannelFbids: config.nativeAndroid!.historySync.supportedBotChannelFbids,
					supportNewsletter: true
				}
			: webHistorySyncConfig,
		version: isNativeAndroid
			? {
					primary: config.nativeAndroid!.appVersion[0],
					secondary: config.nativeAndroid!.appVersion[1],
					tertiary: config.nativeAndroid!.appVersion[2],
					quaternary: config.nativeAndroid!.appVersion[3]
				}
			: isWindowsCompanion
				? {
						// Captured from WhatsApp Windows Beta 2.2629.100.0:
						// DeviceProps advertises the Windows platform version,
						// independently from the Web bundle version in UserAgent.
						primary: 10
					}
				: {
						primary: 10,
						secondary: 15,
						tertiary: 7
					}
	}
}

export const generateRegistrationNode = (
	{ registrationId, signedPreKey, signedIdentityKey }: SignalCreds,
	config: SocketConfig,
	nativeContext?: NativeAndroidClientPayloadContext
) => {
	// the app version needs to be md5 hashed
	// and passed in
	const version = config.transportProfile === 'native_android' ? config.nativeAndroid!.appVersion : config.version
	const versionString = version.join('.')
	// Captured official Android registration payloads encode the lowercase MD5
	// hex string as base64 input (24 bytes), while Web uses the raw 16-byte
	// digest. Keep the transport-specific representation byte-for-byte.
	const appVersionBuf =
		config.transportProfile === 'native_android'
			? Buffer.from(createHash('md5').update(versionString).digest('hex'), 'base64')
			: createHash('md5').update(versionString).digest()

	const companion = buildCompanionDeviceProps(config)

	const companionProto = proto.DeviceProps.encode(companion).finish()

	const registerPayload: proto.IClientPayload = {
		...getClientPayload(config, nativeContext),
		passive: false,
		devicePairingData: {
			buildHash: appVersionBuf,
			deviceProps: companionProto,
			eRegid: encodeBigEndian(registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature
		}
	}
	if (config.transportProfile !== 'native_android') {
		registerPayload.pull = false
	}

	return proto.ClientPayload.fromObject(registerPayload)
}

export const configureSuccessfulPairing = (
	stanza: BinaryNode,
	{
		advSecretKey,
		signedIdentityKey,
		signalIdentities
	}: Pick<AuthenticationCreds, 'advSecretKey' | 'signedIdentityKey' | 'signalIdentities'>
) => {
	const msgId = stanza.attrs.id

	const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success')

	const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity')
	const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform')
	const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device')
	const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz')

	if (!deviceIdentityNode || !deviceNode) {
		throw new Boom('Missing device-identity or device in pair success node', { data: stanza })
	}

	const bizName = businessNode?.attrs.name
	const jid = deviceNode.attrs.jid
	const lid = deviceNode.attrs.lid

	const { details, hmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content as Buffer)

	let hmacPrefix = Buffer.from([])
	if (accountType !== undefined && accountType === proto.ADVEncryptionType.HOSTED) {
		hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
	}

	const advSign = hmacSign(Buffer.concat([hmacPrefix, details!]), Buffer.from(advSecretKey, 'base64'))
	if (Buffer.compare(hmac!, advSign) !== 0) {
		throw new Boom('Invalid account signature')
	}

	const account = proto.ADVSignedDeviceIdentity.decode(details!)
	const { accountSignatureKey, accountSignature, details: deviceDetails } = account

	const deviceIdentity = proto.ADVDeviceIdentity.decode(deviceDetails!)

	const accountSignaturePrefix =
		deviceIdentity.deviceType === proto.ADVEncryptionType.HOSTED
			? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
			: WA_ADV_ACCOUNT_SIG_PREFIX
	const accountMsg = Buffer.concat([accountSignaturePrefix, deviceDetails!, signedIdentityKey.public])
	if (!Curve.verify(accountSignatureKey!, accountMsg, accountSignature!)) {
		throw new Boom('Failed to verify account signature')
	}

	const deviceMsg = Buffer.concat([
		WA_ADV_DEVICE_SIG_PREFIX,
		deviceDetails!,
		signedIdentityKey.public,
		accountSignatureKey!
	])
	account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg)

	const identity = createSignalIdentity(lid!, accountSignatureKey!)
	const accountEnc = encodeSignedDeviceIdentity(account, false)

	const reply: BinaryNode = {
		tag: 'iq',
		attrs: {
			to: S_WHATSAPP_NET,
			type: 'result',
			id: msgId!
		},
		content: [
			{
				tag: 'pair-device-sign',
				attrs: {},
				content: [
					{
						tag: 'device-identity',
						attrs: { 'key-index': deviceIdentity.keyIndex!.toString() },
						content: accountEnc
					}
				]
			}
		]
	}

	const authUpdate: Partial<AuthenticationCreds> = {
		account,
		me: { id: jid!, name: bizName, lid },
		signalIdentities: [...(signalIdentities || []), identity],
		platform: platformNode?.attrs.name
	}

	return {
		creds: authUpdate,
		reply
	}
}

export const encodeSignedDeviceIdentity = (account: proto.IADVSignedDeviceIdentity, includeSignatureKey: boolean) => {
	account = { ...account }
	// set to null if we are not to include the signature key
	// or if we are including the signature key but it is empty
	if (!includeSignatureKey || !account.accountSignatureKey?.length) {
		account.accountSignatureKey = null
	}

	return proto.ADVSignedDeviceIdentity.encode(account).finish()
}
