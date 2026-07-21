import { randomBytes, randomUUID } from 'crypto'
import type { AuthenticationCreds, PairingCodeProfile, SocketConfig } from '../Types'
import { type BinaryNode, S_WHATSAPP_NET } from '../WABinary'
import { getPlatformId, isAndroidBrowser } from './browser-utils'
import { selectVerifiedSmbAndroidDeviceProfile } from './smb-android-device-catalog'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', ''])

export const resolvePairingCodeProfileFromEnv = (
	env: Readonly<Record<string, string | undefined>> = process.env
): PairingCodeProfile => {
	const explicitProfile = env.PAIR_CODE_PROFILE?.trim().toLowerCase()
	if (explicitProfile) {
		if (explicitProfile === 'web' || explicitProfile === 'smb_android') return explicitProfile
		throw new Error('PAIR_CODE_PROFILE must be either "smb_android" or "web"')
	}

	const legacySwitch = env.PAIR_CODE?.trim().toLowerCase()
	if (legacySwitch === undefined || FALSE_VALUES.has(legacySwitch)) return 'smb_android'
	if (TRUE_VALUES.has(legacySwitch)) return 'web'

	throw new Error('PAIR_CODE must be a boolean; true selects the legacy Web pair-code profile')
}

/**
 * Binds a socket to the profile stored with its credentials. Credential files
 * created before this field existed are Web sessions by construction.
 */
export const resolveSessionPairingCodeProfile = (
	configuredProfile: PairingCodeProfile,
	creds: Pick<AuthenticationCreds, 'pairingCodeProfile' | 'registered'>
): PairingCodeProfile => {
	// Credentials that predate the marker were registered exclusively through
	// the Web path. Keep them on Web even though fresh sessions now default to
	// SMB_ANDROID; requiring an env override would brick existing deployments.
	if (!creds.pairingCodeProfile && creds.registered) return 'web'

	const storedProfile = creds.pairingCodeProfile
	if (!storedProfile) return configuredProfile
	if (storedProfile !== configuredProfile) {
		throw new Error(
			`Pair-code profile mismatch: this session is ${storedProfile}, but ${configuredProfile} was requested. ` +
				'Use the stored profile or create a new session; profiles cannot share credentials.'
		)
	}

	return storedProfile
}

export const ensureSmbAndroidDeviceIdentity = (
	creds: AuthenticationCreds
): NonNullable<AuthenticationCreds['smbAndroidDeviceIdentity']> => {
	if (creds.registered && !creds.smbAndroidDeviceIdentity) {
		throw new Error(
			'Registered SMB_ANDROID credentials are missing their device identity; refusing to generate a different companion identity'
		)
	}

	creds.smbAndroidDeviceIdentity ??= {
		phoneId: randomUUID(),
		deviceExpId: randomBytes(16).toString('base64'),
		deviceProfile: selectVerifiedSmbAndroidDeviceProfile()
	}
	// Never rewrite a profile already used by a registered SMB_ANDROID session.
	if (!creds.registered && !creds.smbAndroidDeviceIdentity.deviceProfile) {
		creds.smbAndroidDeviceIdentity.deviceProfile = selectVerifiedSmbAndroidDeviceProfile()
	}

	return creds.smbAndroidDeviceIdentity
}

export type PairingCodeWireProfile = {
	profile: PairingCodeProfile
	platformId: string
	platformDisplay: string
	nonce: Buffer | string
}

export const getPairingCodeWireProfile = (
	profile: PairingCodeProfile,
	browser: SocketConfig['browser'],
	androidOsVersion?: string
): PairingCodeWireProfile => {
	if (profile === 'smb_android') {
		const androidRelease = androidOsVersion || browser[0] || '14'
		return {
			profile,
			platformId: 'e',
			platformDisplay: `Android ${androidRelease}`,
			nonce: Buffer.alloc(0)
		}
	}

	return {
		profile,
		platformId: isAndroidBrowser(browser) ? getPlatformId('Chrome') : getPlatformId(browser[1]),
		platformDisplay: isAndroidBrowser(browser) ? 'Chrome (Mac OS)' : `${browser[1]} (${browser[0]})`,
		nonce: '0'
	}
}

export const buildPairingCodeCompanionHello = ({
	jid,
	messageId,
	wrappedCompanionEphemeralPublicKey,
	companionServerAuthPublicKey,
	wireProfile
}: {
	jid: string
	messageId: string
	wrappedCompanionEphemeralPublicKey: Buffer
	companionServerAuthPublicKey: Uint8Array
	wireProfile: PairingCodeWireProfile
}): BinaryNode => ({
	tag: 'iq',
	attrs: {
		to: S_WHATSAPP_NET,
		type: 'set',
		id: messageId,
		xmlns: 'md'
	},
	content: [
		{
			tag: 'link_code_companion_reg',
			attrs: {
				jid,
				stage: 'companion_hello',
				should_show_push_notification: 'true'
			},
			content: [
				{
					tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
					attrs: {},
					content: wrappedCompanionEphemeralPublicKey
				},
				{
					tag: 'companion_server_auth_key_pub',
					attrs: {},
					content: companionServerAuthPublicKey
				},
				{
					tag: 'companion_platform_id',
					attrs: {},
					content: wireProfile.platformId
				},
				{
					tag: 'companion_platform_display',
					attrs: {},
					content: wireProfile.platformDisplay
				},
				{
					tag: 'link_code_pairing_nonce',
					attrs: {},
					content: wireProfile.nonce
				}
			]
		}
	]
})
