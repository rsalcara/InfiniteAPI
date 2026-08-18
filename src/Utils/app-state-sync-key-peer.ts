import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'
import { jidDecode } from '../WABinary'

type BuildAppStateSyncKeyPeerNodeOptions = {
	targetDeviceJid: string
	messageId: string
	encrypted: { type: string; ciphertext: Uint8Array }
	deviceIdentity?: Uint8Array
}

/** Builds the direct SendPeerMessageJob-compatible stanza used by syncd key types 38/39. */
export const buildAppStateSyncKeyPeerNode = ({
	targetDeviceJid,
	messageId,
	encrypted,
	deviceIdentity
}: BuildAppStateSyncKeyPeerNodeOptions): BinaryNode => {
	const target = jidDecode(targetDeviceJid)
	if (!target || target.device === undefined) {
		throw new Boom('App-state peer message requires an explicit target device', { statusCode: 400 })
	}

	if (encrypted.type === 'pkmsg' && !deviceIdentity) {
		throw new Boom('Missing signed device identity for app-state peer message', { statusCode: 500 })
	}

	const content: BinaryNode[] = [
		{
			tag: 'enc',
			attrs: { v: '2', type: encrypted.type },
			content: encrypted.ciphertext
		}
	]
	if (encrypted.type === 'pkmsg') {
		content.push({ tag: 'device-identity', attrs: {}, content: deviceIdentity })
	}

	return {
		tag: 'message',
		attrs: {
			id: messageId,
			to: targetDeviceJid,
			type: 'protocol',
			category: 'peer',
			push_priority: 'high'
		},
		content
	}
}
