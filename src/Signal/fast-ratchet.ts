import $protobuf from 'protobufjs/minimal.js'
import type { SignalDataTypeMap } from '../Types'
import { generateSenderKey, generateSenderKeyId, generateSenderSigningKey } from './Group/keyhelper'

const FAST_RATCHET_VERSION = Buffer.from([0x33])
const FAST_RATCHET_CHAIN_COUNT = 8

export type FastRatchetSenderKeyState = SignalDataTypeMap['fast-ratchet-sender-key']

const writeBytes = ($writer: $protobuf.Writer, field: number, value: Uint8Array): void => {
	$writer.uint32((field << 3) | 2).bytes(value)
}

export const createFastRatchetSenderKeyState = (): FastRatchetSenderKeyState => {
	const signingKey = generateSenderSigningKey()
	return {
		senderKeyId: generateSenderKeyId(),
		iteration: 0,
		chainKeys: [generateSenderKey(), ...new Array(FAST_RATCHET_CHAIN_COUNT - 1).fill(null).map(() => Buffer.alloc(0))],
		signingPublic: signingKey.public,
		signingPrivate: signingKey.private
	}
}

/**
 * A4M/C88Z wire format used by Android's SendLiveLocationKeyJob:
 * 0x33 || protobuf(id=1, iteration=2, repeated chainKeys=3, signingKey=4).
 */
export const encodeFastRatchetSenderKeyDistribution = (state: FastRatchetSenderKeyState): Buffer => {
	const writer = $protobuf.Writer.create()
	writer.uint32(8).uint32(state.senderKeyId)
	writer.uint32(16).uint32(state.iteration)
	for (const chainKey of state.chainKeys) writeBytes(writer, 3, chainKey)
	writeBytes(writer, 4, state.signingPublic)
	return Buffer.concat([FAST_RATCHET_VERSION, Buffer.from(writer.finish())])
}
