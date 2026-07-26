import { randomBytes, randomInt } from 'crypto'
import { generateKeyPair } from 'libsignal/src/curve'
import $protobuf from 'protobufjs/minimal.js'

const FAST_RATCHET_VERSION = Buffer.from([0x33])
const FAST_RATCHET_CHAIN_COUNT = 8

export type FastRatchetSenderKeyState = {
	senderKeyId: number
	iteration: number
	chainKeys: Buffer[]
	signingPublic: Buffer
	signingPrivate: Buffer
}

const writeBytes = ($writer: $protobuf.Writer, field: number, value: Uint8Array): void => {
	$writer.uint32((field << 3) | 2).bytes(value)
}

export const createFastRatchetSenderKeyState = (): FastRatchetSenderKeyState => {
	const signingKey = generateKeyPair()
	return {
		senderKeyId: randomInt(0x7fffffff),
		iteration: 0,
		chainKeys: [randomBytes(32), ...new Array(FAST_RATCHET_CHAIN_COUNT - 1).fill(null).map(() => Buffer.alloc(0))],
		signingPublic: Buffer.from(signingKey.pubKey),
		signingPrivate: Buffer.from(signingKey.privKey)
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
