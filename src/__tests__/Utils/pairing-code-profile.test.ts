import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import { initAuthCreds } from '../../Utils/auth-utils'
import { Browsers } from '../../Utils/browser-utils'
import {
	buildPairingCodeCompanionHello,
	ensureSmbAndroidDeviceIdentity,
	getPairingCodeWireProfile,
	resolvePairingCodeProfileFromEnv,
	resolveSessionPairingCodeProfile
} from '../../Utils/pairing-code-profile'
import {
	selectVerifiedSmbAndroidDeviceProfile,
	SMB_ANDROID_DEVICE_CATALOG,
	validateSmbAndroidDeviceCatalog
} from '../../Utils/smb-android-device-catalog'
import { buildCompanionDeviceProps, getClientPayload } from '../../Utils/validate-connection'
import { getBinaryNodeChild } from '../../WABinary'

describe('pairing-code profiles', () => {
	it('defaults fresh pair-code sessions to SMB_ANDROID and keeps PAIR_CODE=true as the Web fallback', () => {
		expect(resolvePairingCodeProfileFromEnv({})).toBe('smb_android')
		expect(resolvePairingCodeProfileFromEnv({ PAIR_CODE: 'false' })).toBe('smb_android')
		expect(resolvePairingCodeProfileFromEnv({ PAIR_CODE: 'true' })).toBe('web')
		expect(resolvePairingCodeProfileFromEnv({ PAIR_CODE_PROFILE: 'web' })).toBe('web')
	})

	it('fails with an actionable error for invalid environment values', () => {
		expect(() => resolvePairingCodeProfileFromEnv({ PAIR_CODE: 'sometimes' })).toThrow('PAIR_CODE must be a boolean')
		expect(() => resolvePairingCodeProfileFromEnv({ PAIR_CODE_PROFILE: 'android' })).toThrow(
			'PAIR_CODE_PROFILE must be either'
		)
	})

	it('keeps pre-marker registered sessions on Web and refuses marked cross-profile credential reuse', () => {
		expect(resolveSessionPairingCodeProfile('web', { registered: true })).toBe('web')
		expect(resolveSessionPairingCodeProfile('smb_android', { registered: true })).toBe('web')
		expect(() =>
			resolveSessionPairingCodeProfile('smb_android', { registered: true, pairingCodeProfile: 'web' })
		).toThrow('Pair-code profile mismatch')
		expect(
			resolveSessionPairingCodeProfile('smb_android', {
				registered: true,
				pairingCodeProfile: 'smb_android'
			})
		).toBe('smb_android')
	})

	it('builds the verified SMB_ANDROID ClientPayload without WebInfo', () => {
		const creds = initAuthCreds()
		const identity = ensureSmbAndroidDeviceIdentity(creds)
		const config = {
			...DEFAULT_CONNECTION_CONFIG,
			pairingCodeProfile: 'smb_android' as const,
			browser: Browsers.android('14')
		}
		const payload = getClientPayload(config, creds)
		const props = buildCompanionDeviceProps(config, creds)

		expect(payload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.SMB_ANDROID)
		expect(payload.userAgent?.appVersion?.quaternary).toBe(83)
		expect(payload.userAgent?.phoneId).toBe(creds.smbAndroidDeviceIdentity?.phoneId)
		expect(payload.userAgent?.manufacturer).toBe(identity.deviceProfile?.manufacturer)
		expect(payload.userAgent?.device).toBe(identity.deviceProfile?.device)
		expect(payload.webInfo).toBeUndefined()
		expect(props.platformType).toBe(proto.DeviceProps.PlatformType.ANDROID_PHONE)
		expect(props.os).toBe(`Android ${identity.deviceProfile?.osVersion}`)
		expect(props.historySyncConfig?.supportCallLogHistory).toBe(true)
		expect(props.historySyncConfig?.supportBizHostedMsg).toBe(false)
	})

	it('validates every catalog tuple and corrects the S26 model codes', () => {
		expect(validateSmbAndroidDeviceCatalog(SMB_ANDROID_DEVICE_CATALOG)).toHaveLength(21)
		expect(SMB_ANDROID_DEVICE_CATALOG.find(profile => profile.commercialName === 'Galaxy S26+')?.device).toBe(
			'SM-S947B'
		)
		expect(SMB_ANDROID_DEVICE_CATALOG.find(profile => profile.commercialName === 'Galaxy S26')?.device).toBe('SM-S942B')
	})

	it('selects only once and persists a complete immutable profile snapshot in credentials', () => {
		const creds = initAuthCreds()
		const first = ensureSmbAndroidDeviceIdentity(creds)
		const serialized = JSON.parse(JSON.stringify(creds))
		const second = ensureSmbAndroidDeviceIdentity(serialized)

		expect(first.deviceProfile).toBeDefined()
		expect(second).toEqual(first)
		expect(second.deviceProfile).toEqual(first.deviceProfile)
		expect(Object.keys(second.deviceProfile!)).toEqual(
			expect.arrayContaining([
				'catalogId',
				'commercialName',
				'manufacturer',
				'device',
				'osVersion',
				'osBuildNumber',
				'verified'
			])
		)
	})

	it('rejects empty, incomplete, unverified and Android/build-incoherent catalogs', () => {
		expect(() => validateSmbAndroidDeviceCatalog([])).toThrow('at least one verified profile')
		expect(() => validateSmbAndroidDeviceCatalog([{ ...SMB_ANDROID_DEVICE_CATALOG[0]!, device: '' }])).toThrow(
			'incomplete'
		)
		expect(() =>
			validateSmbAndroidDeviceCatalog([{ ...SMB_ANDROID_DEVICE_CATALOG[0]!, verified: false as true }])
		).toThrow('not verified')
		expect(() =>
			validateSmbAndroidDeviceCatalog([
				{ ...SMB_ANDROID_DEVICE_CATALOG[0]!, osVersion: '14', osBuildNumber: 'BP2A.250605.031.A3' }
			])
		).toThrow('requires launch Android 16')
		expect(() => validateSmbAndroidDeviceCatalog([{ ...SMB_ANDROID_DEVICE_CATALOG[0]!, device: 'SM-S947B' }])).toThrow(
			'does not match the verified model code'
		)
	})

	it('uses the selector only for a fresh identity and rejects an invalid selector result', () => {
		expect(selectVerifiedSmbAndroidDeviceProfile(SMB_ANDROID_DEVICE_CATALOG, () => 3).catalogId).toBe(
			'galaxy-s25-ultra-eu'
		)
		expect(() => selectVerifiedSmbAndroidDeviceProfile(SMB_ANDROID_DEVICE_CATALOG, () => 21)).toThrow('invalid index')
	})

	it('does not retrofit an already registered SMB_ANDROID identity', () => {
		const creds = initAuthCreds()
		creds.registered = true
		creds.pairingCodeProfile = 'smb_android'
		creds.smbAndroidDeviceIdentity = { phoneId: 'existing-phone', deviceExpId: 'existing-exp' }

		expect(ensureSmbAndroidDeviceIdentity(creds)).toEqual({
			phoneId: 'existing-phone',
			deviceExpId: 'existing-exp'
		})

		creds.smbAndroidDeviceIdentity = undefined
		expect(() => ensureSmbAndroidDeviceIdentity(creds)).toThrow('refusing to generate a different companion identity')
	})

	it('preserves the existing Web ClientPayload and WebInfo', () => {
		const config = {
			...DEFAULT_CONNECTION_CONFIG,
			pairingCodeProfile: 'web' as const,
			browser: Browsers.macOS('Chrome')
		}
		const payload = getClientPayload(config)

		expect(payload.userAgent?.platform).toBe(proto.ClientPayload.UserAgent.Platform.WEB)
		expect(payload.webInfo).toBeDefined()
		expect(buildCompanionDeviceProps(config).platformType).toBe(proto.DeviceProps.PlatformType.CHROME)
	})

	it('uses Android phone code e and an empty binary nonce for SMB_ANDROID', () => {
		const wireProfile = getPairingCodeWireProfile('smb_android', Browsers.android('14'), '16')
		const node = buildPairingCodeCompanionHello({
			jid: '5511999999999@s.whatsapp.net',
			messageId: 'test-smb',
			wrappedCompanionEphemeralPublicKey: Buffer.from([1, 2]),
			companionServerAuthPublicKey: Buffer.from([3, 4]),
			wireProfile
		})
		const registration = getBinaryNodeChild(node, 'link_code_companion_reg')!

		expect(getBinaryNodeChild(registration, 'companion_platform_id')?.content).toBe('e')
		expect(getBinaryNodeChild(registration, 'companion_platform_display')?.content).toBe('Android 16')
		expect(getBinaryNodeChild(registration, 'link_code_pairing_nonce')?.content).toEqual(Buffer.alloc(0))
	})

	it('keeps the established Web pair-code wire values unchanged', () => {
		// The historical default browser tuple is Android-looking, but the
		// proven Web pair-code path must still override it to Chrome/1.
		const wireProfile = getPairingCodeWireProfile('web', Browsers.android('14'))
		const node = buildPairingCodeCompanionHello({
			jid: '5511999999999@s.whatsapp.net',
			messageId: 'test-web',
			wrappedCompanionEphemeralPublicKey: Buffer.from([1, 2]),
			companionServerAuthPublicKey: Buffer.from([3, 4]),
			wireProfile
		})
		const registration = getBinaryNodeChild(node, 'link_code_companion_reg')!

		expect(getBinaryNodeChild(registration, 'companion_platform_id')?.content).toBe('1')
		expect(getBinaryNodeChild(registration, 'link_code_pairing_nonce')?.content).toBe('0')
	})
})
