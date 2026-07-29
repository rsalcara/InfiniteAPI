import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import type { SocketConfig } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { buildPairingQRData, getPairCodeCompanionIdentity } from '../../Utils/companion-reg-client-utils'
import { buildCompanionDeviceProps, generateRegistrationNode } from '../../Utils/validate-connection'

const webConfig = (overrides: Partial<SocketConfig> = {}): SocketConfig => ({
	...DEFAULT_CONNECTION_CONFIG,
	transportProfile: 'web',
	browser: ['Windows', 'Edge', '10.0.26200'],
	syncFullHistory: true,
	...overrides
})

describe('official Web history-sync DeviceProps', () => {
	it('matches the captured WhatsApp Windows full-history capability profile', () => {
		const props = buildCompanionDeviceProps(webConfig())

		expect(props.platformType).toBe(proto.DeviceProps.PlatformType.UWP)
		expect(props.requireFullSync).toBe(true)
		expect(props.version).toEqual({ primary: 10 })
		expect(props.historySyncConfig).toEqual({
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
		})
		expect(props.historySyncConfig).not.toHaveProperty('storageQuotaMb')
		expect(props.historySyncConfig).not.toHaveProperty('recentSyncDaysLimit')
		expect(props.historySyncConfig).not.toHaveProperty('fullSyncSizeMbLimit')
	})

	it('uses the Windows hybrid Web sub-platform in the registration payload', () => {
		const payload = generateRegistrationNode(initAuthCreds(), webConfig())

		expect(payload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
		expect(payload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID)
	})

	it('keeps Pair Code on Edge while DeviceProps uses UWP for full history', () => {
		const config = webConfig()

		// Pair Code companion_platform_id keeps the configured Web client;
		// UWP=8 is reserved for the Windows hybrid QR field.
		expect(getPairCodeCompanionIdentity(config.browser, config.syncFullHistory)).toMatchObject({
			platformId: '2',
			platformName: 'EDGE',
			platformDisplay: 'Edge (Windows)',
			windowsHybrid: true
		})
		// Registration DeviceProps uses the DeviceProps enum.
		expect(buildCompanionDeviceProps(config).platformType).toBe(proto.DeviceProps.PlatformType.UWP)
		expect(proto.DeviceProps.PlatformType.UWP).toBe(21)
	})

	it('includes the UWP Web-client identity in an official Windows hybrid QR', () => {
		expect(buildPairingQRData('ref', 'noise', 'identity', 'adv', webConfig().browser, 'web', true)).toBe(
			'https://wa.me/settings/linked_devices#ref,noise,identity,adv,8'
		)
	})

	it('preserves the configured browser Pair Code identity outside WIN_HYBRID mode', () => {
		expect(getPairCodeCompanionIdentity(webConfig().browser, false)).toMatchObject({
			platformId: '2',
			platformName: 'EDGE',
			platformDisplay: 'Edge (Windows)',
			windowsHybrid: false
		})
	})

	it('preserves the reduced-history profile when syncFullHistory is explicitly disabled', () => {
		const props = buildCompanionDeviceProps(webConfig({ syncFullHistory: false }))

		expect(props.requireFullSync).toBe(false)
		expect(props.platformType).toBe(proto.DeviceProps.PlatformType.EDGE)
		expect(props.historySyncConfig).toMatchObject({
			storageQuotaMb: 10240,
			inlineInitialPayloadInE2EeMsg: true,
			supportCallLogHistory: false,
			supportGroupHistory: false
		})
		expect(props.historySyncConfig?.fullSyncDaysLimit).toBeUndefined()
		expect(props.historySyncConfig?.onDemandReady).toBeUndefined()
		expect(props.historySyncConfig?.completeOnDemandReady).toBeUndefined()
	})

	it('uses UWP only for an explicitly configured Windows companion', () => {
		expect(buildCompanionDeviceProps(webConfig()).platformType).toBe(proto.DeviceProps.PlatformType.UWP)
		expect(buildCompanionDeviceProps(webConfig({ browser: ['Mac OS', 'Edge', '15.0'] })).platformType).toBe(
			proto.DeviceProps.PlatformType.EDGE
		)
		expect(buildCompanionDeviceProps(webConfig({ browser: ['Ubuntu', 'Chrome', '24.04'] })).platformType).toBe(
			proto.DeviceProps.PlatformType.CHROME
		)
	})

	it('round-trips the official fields through the registration protobuf', () => {
		const encoded = proto.DeviceProps.encode(buildCompanionDeviceProps(webConfig())).finish()
		const decoded = proto.DeviceProps.decode(encoded)

		expect(decoded.platformType).toBe(proto.DeviceProps.PlatformType.UWP)
		expect(decoded.requireFullSync).toBe(true)
		expect(decoded.historySyncConfig).toMatchObject({
			fullSyncDaysLimit: 365,
			onDemandReady: true,
			completeOnDemandReady: true,
			thumbnailSyncDaysLimit: 60,
			supportGroupHistory: true,
			supportManusHistory: true,
			supportHatchHistory: true,
			supportedBotChannelFbids: []
		})
		expect(Object.prototype.hasOwnProperty.call(decoded.historySyncConfig, 'storageQuotaMb')).toBe(false)
		expect(Object.prototype.hasOwnProperty.call(decoded.historySyncConfig, 'recentSyncDaysLimit')).toBe(false)
		expect(Object.prototype.hasOwnProperty.call(decoded.historySyncConfig, 'fullSyncSizeMbLimit')).toBe(false)
	})
})
