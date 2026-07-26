import { createCipheriv, createHmac, randomBytes, randomInt } from 'crypto'
import { generateKeyPair } from 'libsignal/src/curve'
import $protobuf from 'protobufjs/minimal.js'
import { Curve, hkdf } from '../Utils/crypto'

const FAST_RATCHET_VERSION = Buffer.from([0x33])
const FAST_RATCHET_CHAIN_COUNT = 8
const FAST_RATCHET_INFO = 'WhisperGroup'

export type FastRatchetSenderKeyState = {
	senderKeyId: number
	iteration: number
	chainKeys: Buffer[]
	signingPublic: Buffer
	signingPrivate: Buffer
}

const hmacByte = (key: Uint8Array, value: number): Buffer =>
	createHmac('sha256', key)
		.update(Buffer.from([value]))
		.digest()

const writeBytes = ($writer: $protobuf.Writer, field: number, value: Uint8Array): void => {
	$writer.uint32((field << 3) | 2).bytes(value)
}

const iterationParts = (iteration: number, chainCount = FAST_RATCHET_CHAIN_COUNT): number[] => {
	const bitsPerChain = 32 / chainCount
	const mask = (1 << bitsPerChain) - 1
	const parts = new Array<number>(chainCount)
	for (let offset = 0; offset < chainCount; offset++) {
		parts[chainCount - offset - 1] = (iteration >>> (bitsPerChain * offset)) & mask
	}

	for (let index = 0; index < chainCount - 1; index++) parts[index] = parts[index]! + 1
	return parts
}

/**
 * Android persists a compact iteration-zero state: the random seed is the
 * first chain and the other seven entries are empty. Before deriving a
 * message key, C9NK.A03 expands that seed into all eight chain values.
 */
const expandedChainKeys = (state: FastRatchetSenderKeyState): Buffer[] => {
	const keys: Buffer[] = state.chainKeys.map(value => Buffer.from(value) as Buffer)
	if (state.iteration !== 0 || keys.length < 2 || keys[1]!.length !== 0) return keys

	for (let index = 0; index < keys.length - 1; index++) {
		const source = index === 0 ? keys[0]! : keys[index]!
		keys[index + 1] = hmacByte(source, index + 3)
		keys[index] = hmacByte(source, index + 2)
	}

	return keys
}

const advanceChainKeys = (state: FastRatchetSenderKeyState, count: number): Buffer[] => {
	if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`Invalid fast-ratchet advance count: ${count}`)
	const nextIteration = state.iteration + count
	const currentParts = iterationParts(state.iteration)
	const nextParts = iterationParts(nextIteration)
	const keys = expandedChainKeys(state)

	for (let index = 0; index < keys.length; index++) {
		while (nextParts[index]! > currentParts[index]!) {
			if (index < keys.length - 1 && nextParts[index]! - 1 === currentParts[index]!) {
				keys[index + 1] = hmacByte(keys[index]!, index + 3)
				currentParts[index + 1] = 0
			}

			keys[index] = hmacByte(keys[index]!, index + 2)
			currentParts[index] = currentParts[index]! + 1
		}
	}

	return keys
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

/**
 * Produces Android's `frskmsg` payload and returns the advanced durable state.
 * This is used by live-location updates/final notifications, not by the
 * ordinary initial LiveLocationMessage.
 */
export const encryptFastRatchetMessage = (
	state: FastRatchetSenderKeyState,
	plaintext: Uint8Array
): { ciphertext: Buffer; nextState: FastRatchetSenderKeyState } => {
	const chains = expandedChainKeys(state)
	const messageSeed = hmacByte(chains[chains.length - 1]!, 1)
	const material = Buffer.from(hkdf(messageSeed, 48, { info: FAST_RATCHET_INFO }))
	const iv = material.subarray(0, 16)
	const key = material.subarray(16, 48)
	const cipher = createCipheriv('aes-256-cbc', key, iv)
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

	const writer = $protobuf.Writer.create()
	writer.uint32(8).uint32(state.senderKeyId)
	writer.uint32(16).uint32(state.iteration)
	writeBytes(writer, 3, encrypted)
	const body = Buffer.from(writer.finish())
	const signed = Buffer.concat([FAST_RATCHET_VERSION, body])
	const signature = Buffer.from(Curve.sign(state.signingPrivate, signed))

	return {
		ciphertext: Buffer.concat([signed, signature]),
		nextState: {
			...state,
			iteration: state.iteration + 1,
			chainKeys: advanceChainKeys(state, 1)
		}
	}
}
