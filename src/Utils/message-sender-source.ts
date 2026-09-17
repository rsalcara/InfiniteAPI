import type { ConnectionTransportProfile, MessageSenderSource, WAMessage } from '../Types'
import { jidDecode } from '../WABinary'

const USER_JID_SERVERS = new Set(['c.us', 's.whatsapp.net', 'lid', 'hosted', 'hosted.lid'])

type ClassifyProtocolSenderOptions = {
	authorJid?: string
	currentDeviceJids?: readonly (string | undefined)[]
	currentTransportProfile?: ConnectionTransportProfile
}

export const selectNotificationSenderAuthorJid = ({
	participantJid,
	rawRemoteJid
}: {
	participantJid?: string
	rawRemoteJid?: string
}): string | undefined => participantJid || rawRemoteJid

const unknownSenderSource = (): MessageSenderSource => ({
	type: 'unknown',
	confidence: 'unknown',
	evidence: 'missing_author_device'
})

const explicitDeviceId = (jid: string | undefined): number | undefined => {
	if (typeof jid !== 'string') return undefined

	const atIndex = jid.indexOf('@')
	if (atIndex <= 0) return undefined

	const user = jid.slice(0, atIndex)
	const deviceIndex = user.lastIndexOf(':')
	if (deviceIndex < 0) return undefined

	const deviceText = user.slice(deviceIndex + 1)
	if (!/^\d+$/.test(deviceText)) return undefined

	const device = Number(deviceText)
	return Number.isSafeInteger(device) ? device : undefined
}

const canonicalUserServer = (server: string) => (server === 'c.us' || server === 's.whatsapp.net' ? 'pn' : server)

const isCurrentDevice = (
	author: NonNullable<ReturnType<typeof jidDecode>>,
	authorDeviceId: number,
	currentDeviceJids: readonly (string | undefined)[]
) => {
	const explicitCurrentDeviceIds = new Set(
		currentDeviceJids
			.map(currentJid => explicitDeviceId(currentJid))
			.filter((deviceId): deviceId is number => deviceId !== undefined)
	)

	return currentDeviceJids.some(currentJid => {
		const current = jidDecode(currentJid)
		const currentDeviceId = explicitDeviceId(currentJid)
		const sameUser =
			!!current &&
			current.user === author.user &&
			canonicalUserServer(current.server) === canonicalUserServer(author.server)
		if (!sameUser) return false

		return (
			currentDeviceId === authorDeviceId ||
			(currentDeviceId === undefined && explicitCurrentDeviceIds.has(authorDeviceId))
		)
	})
}

/**
 * Classifies the author while the protocol JID still has its device suffix.
 * Device 0 is the primary phone; positive IDs are linked devices. A positive
 * suffix proves only that another companion authored the event — it does not
 * identify that companion as WhatsApp Web, a phone app, or a tablet.
 */
export const classifyProtocolMessageSenderSource = ({
	authorJid,
	currentDeviceJids = [],
	currentTransportProfile
}: ClassifyProtocolSenderOptions): MessageSenderSource => {
	const author = jidDecode(authorJid)
	if (!author || !author.user || !USER_JID_SERVERS.has(author.server)) return unknownSenderSource()
	if (author.user === 'server' || author.user === '0') return unknownSenderSource()

	const deviceId = explicitDeviceId(authorJid)
	if (deviceId === undefined) return unknownSenderSource()
	if (!Number.isInteger(deviceId) || deviceId < 0) return unknownSenderSource()

	if (deviceId === 0) {
		return {
			type: 'primary_device',
			authorDeviceJid: authorJid,
			deviceId,
			confidence: 'high',
			evidence: 'author_device_jid'
		}
	}

	if (currentTransportProfile && isCurrentDevice(author, deviceId, currentDeviceJids)) {
		return {
			type: currentTransportProfile === 'web' ? 'web' : 'linked_device',
			authorDeviceJid: authorJid,
			deviceId,
			platform: currentTransportProfile === 'web' ? 'WEB' : 'ANDROID',
			confidence: 'high',
			evidence: 'current_client_transport'
		}
	}

	return {
		type: 'linked_device',
		authorDeviceJid: authorJid,
		deviceId,
		confidence: 'low',
		evidence: 'author_device_jid'
	}
}

export const classifyCurrentClientMessageSenderSource = (
	transportProfile: ConnectionTransportProfile,
	currentDeviceJid?: string
): MessageSenderSource => {
	const deviceId = explicitDeviceId(currentDeviceJid)
	const platform = transportProfile === 'web' ? 'WEB' : 'ANDROID'
	if (deviceId === 0) {
		return {
			type: 'primary_device',
			...(currentDeviceJid === undefined ? {} : { authorDeviceJid: currentDeviceJid }),
			deviceId,
			platform,
			confidence: 'high',
			evidence: 'current_client_transport'
		}
	}

	return {
		type: transportProfile === 'web' ? 'web' : 'linked_device',
		...(currentDeviceJid === undefined ? {} : { authorDeviceJid: currentDeviceJid }),
		...(deviceId === undefined ? {} : { deviceId }),
		platform,
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
