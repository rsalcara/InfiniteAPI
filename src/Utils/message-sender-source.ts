import type { ConnectionTransportProfile, MessageSenderSource, WAMessage } from '../Types'
import { jidDecode } from '../WABinary'

const USER_JID_SERVERS = new Set(['c.us', 's.whatsapp.net', 'lid', 'hosted', 'hosted.lid'])
const WEB_PLATFORM_TYPES = new Set(['CHROME', 'FIREFOX', 'IE', 'OPERA', 'SAFARI', 'EDGE', 'DESKTOP', 'UWP'])

type ClassifyProtocolSenderOptions = {
	authorJid?: string
	currentDeviceJids?: readonly (string | undefined)[]
	currentTransportProfile?: ConnectionTransportProfile
	knownPlatform?: string
}

const unknownSenderSource = (): MessageSenderSource => ({
	type: 'unknown',
	confidence: 'unknown',
	evidence: 'missing_author_device'
})

const isCurrentDevice = (
	author: NonNullable<ReturnType<typeof jidDecode>>,
	currentDeviceJids: readonly (string | undefined)[]
) =>
	currentDeviceJids.some(currentJid => {
		const current = jidDecode(currentJid)
		return (
			!!current &&
			current.user === author.user &&
			current.server === author.server &&
			(current.device ?? 0) === (author.device ?? 0)
		)
	})

/**
 * Classifies the author while the protocol JID still has its device suffix.
 * Device 0 is the primary phone; positive IDs are linked devices. WhatsApp
 * does not disclose a companion's platform in every message stanza.
 */
export const classifyProtocolMessageSenderSource = ({
	authorJid,
	currentDeviceJids = [],
	currentTransportProfile,
	knownPlatform
}: ClassifyProtocolSenderOptions): MessageSenderSource => {
	const author = jidDecode(authorJid)
	if (!author || !author.user || !USER_JID_SERVERS.has(author.server)) return unknownSenderSource()
	if (author.user === 'server' || author.user === '0') return unknownSenderSource()

	const deviceId = author.device ?? 0
	if (!Number.isInteger(deviceId) || deviceId < 0) return unknownSenderSource()

	if (deviceId === 0) {
		return { type: 'primary_device', deviceId, confidence: 'high', evidence: 'author_device_jid' }
	}

	const platform = knownPlatform?.trim().toUpperCase()
	if (platform) {
		return {
			type: WEB_PLATFORM_TYPES.has(platform) ? 'web' : 'linked_device',
			deviceId,
			platform,
			confidence: 'high',
			evidence: 'author_device_jid_and_platform'
		}
	}

	if (currentTransportProfile && isCurrentDevice(author, currentDeviceJids)) {
		return {
			type: currentTransportProfile === 'web' ? 'web' : 'linked_device',
			deviceId,
			platform: currentTransportProfile === 'web' ? 'WEB' : 'ANDROID',
			confidence: 'high',
			evidence: 'current_client_transport'
		}
	}

	return { type: 'linked_device', deviceId, confidence: 'high', evidence: 'author_device_jid' }
}

export const classifyCurrentClientMessageSenderSource = (
	transportProfile: ConnectionTransportProfile,
	currentDeviceJid?: string
): MessageSenderSource => {
	const deviceId = jidDecode(currentDeviceJid)?.device
	return {
		type: transportProfile === 'web' ? 'web' : 'linked_device',
		...(deviceId === undefined ? {} : { deviceId }),
		platform: transportProfile === 'web' ? 'WEB' : 'ANDROID',
		confidence: 'high',
		evidence: 'current_client_transport'
	}
}

export const classifyMessageWithoutAuthorDevice = (): MessageSenderSource => unknownSenderSource()

/** Allowlisted fields for structured attribution logs. */
export const messageSenderSourceLogFields = (message: WAMessage) => ({
	msgId: message.key.id,
	fromMe: !!message.key.fromMe,
	senderSource: message.senderSource?.type ?? 'unknown',
	senderDeviceId: message.senderSource?.deviceId,
	senderPlatform: message.senderSource?.platform,
	senderSourceConfidence: message.senderSource?.confidence ?? 'unknown',
	senderSourceEvidence: message.senderSource?.evidence ?? 'missing_author_device'
})
