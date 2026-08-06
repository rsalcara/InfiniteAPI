import type { ProtocolWireCapture } from '../Types'
import { type BinaryNode, encodeBinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary'
import type { ILogger } from './logger'

export const validateProtocolWireCapture = (kind: ProtocolWireCapture['kind'], node: BinaryNode): void => {
	if (kind === 'direct_retry') {
		if (node.tag !== 'message') throw new Error('direct retry capture must be a message stanza')
		if (getBinaryNodeChild(node, 'participants')) throw new Error('direct retry capture cannot contain participants')
		if (!getBinaryNodeChild(node, 'enc')) throw new Error('direct retry capture must contain one top-level enc')
		return
	}

	const create = getBinaryNodeChild(node, 'create')
	if (node.tag !== 'iq' || node.attrs.xmlns !== 'w:g2' || node.attrs.type !== 'set' || !create) {
		throw new Error('legacy group-create capture has an invalid IQ envelope')
	}

	if (!create.attrs.subject || !create.attrs.key) throw new Error('legacy group-create capture is missing subject/key')
	if (!getBinaryNodeChildren(create, 'participant').length) {
		throw new Error('legacy group-create capture must contain participants')
	}
}

export const captureProtocolWire = async (
	hook: ((capture: ProtocolWireCapture) => void | Promise<void>) | undefined,
	kind: ProtocolWireCapture['kind'],
	node: BinaryNode,
	logger?: ILogger
): Promise<void> => {
	if (!hook) return
	try {
		validateProtocolWireCapture(kind, node)
		await hook({ kind, node, encoded: encodeBinaryNode(node), capturedAt: Date.now() })
	} catch (error) {
		logger?.warn({ error, kind }, 'protocol wire capture failed; send continues unchanged')
	}
}
