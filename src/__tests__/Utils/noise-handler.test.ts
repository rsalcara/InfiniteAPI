import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import { NOISE_IK_MODE, NOISE_WA_HEADER } from '../../Defaults'
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from '../../Utils/crypto'
import { makeNoiseHandler } from '../../Utils/noise-handler'
import type { BinaryNode } from '../../WABinary/types'

// Create a mock logger
const createMockLogger = () => ({
	child: jest.fn().mockReturnThis(),
	trace: jest.fn(),
	debug: jest.fn(),
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	fatal: jest.fn(),
	level: 'trace'
})

// Helper to create a frame with length prefix
const createFrame = (payload: Buffer) => {
	const frame = Buffer.alloc(3 + payload.length)
	frame.writeUInt8(payload.length >> 16, 0)
	frame.writeUInt16BE(payload.length & 0xffff, 1)
	payload.copy(frame, 3)
	return frame
}

describe('Noise Handler', () => {
	it('reproduces the exact classic IK ClientHello field sizes captured from official Android', () => {
		const ephemeral = Curve.generateKeyPair()
		const initiatorStatic = Curve.generateKeyPair()
		const responderStatic = Curve.generateKeyPair()
		const handler = makeNoiseHandler({
			keyPair: ephemeral,
			NOISE_HEADER: NOISE_WA_HEADER,
			logger: createMockLogger() as any,
			nativeIK: {
				initiatorStatic,
				responderStatic: responderStatic.public
			}
		})

		// The official capture contains a 320-byte encrypted payload. AES-GCM
		// appends a 16-byte tag, so its plaintext ClientPayload is 304 bytes.
		const encoded = handler.createIKClientHello(Buffer.alloc(304, 0x2a))
		const hello = proto.HandshakeMessage.decode(encoded).clientHello!

		expect(encoded).toHaveLength(410)
		expect(hello.ephemeral).toHaveLength(32)
		expect(hello.static).toHaveLength(48)
		expect(hello.payload).toHaveLength(320)
	})

	it('detects an IK ServerHello that explicitly requests the official XX fallback path', () => {
		const handler = makeNoiseHandler({
			keyPair: Curve.generateKeyPair(),
			NOISE_HEADER: NOISE_WA_HEADER,
			logger: createMockLogger() as any,
			nativeIK: {
				initiatorStatic: Curve.generateKeyPair(),
				responderStatic: Curve.generateKeyPair().public
			}
		})

		handler.createIKClientHello(Buffer.from('payload'))
		const handshake = proto.HandshakeMessage.fromObject({
			serverHello: {
				ephemeral: Curve.generateKeyPair().public,
				static: Buffer.alloc(48),
				payload: Buffer.alloc(16)
			}
		})
		expect(handler.requiresXXFallback(handshake)).toBe(true)
		handler.resetToXXFallback()
		expect(handler.requiresXXFallback(handshake)).toBe(false)
	})

	it('completes classic IK against an independent responder state and derives matching transport keys', async () => {
		const ephemeral = Curve.generateKeyPair()
		const initiatorStatic = Curve.generateKeyPair()
		const responderStatic = Curve.generateKeyPair()
		const handler = makeNoiseHandler({
			keyPair: ephemeral,
			NOISE_HEADER: NOISE_WA_HEADER,
			logger: createMockLogger() as any,
			nativeIK: {
				initiatorStatic,
				responderStatic: responderStatic.public
			}
		})
		const clientPayload = Buffer.from('native-client-payload')
		const encoded = handler.createIKClientHello(clientPayload)
		const hello = proto.HandshakeMessage.decode(encoded).clientHello!

		let hash = Buffer.from(NOISE_IK_MODE)
		let salt = hash
		let cipherKey: Buffer | undefined
		let counter = 0
		const mixHash = (data: Uint8Array) => {
			hash = sha256(Buffer.concat([hash, data]))
		}

		const mixKey = (data: Uint8Array) => {
			const material = hkdf(Buffer.from(data), 64, { salt, info: '' })
			salt = Buffer.from(material.subarray(0, 32))
			cipherKey = Buffer.from(material.subarray(32))
			counter = 0
		}

		const iv = () => {
			const value = Buffer.alloc(12)
			value.writeUInt32BE(counter++, 8)
			return value
		}

		const decryptAndHash = (ciphertext: Uint8Array) => {
			const plaintext = aesDecryptGCM(ciphertext, cipherKey!, iv(), hash)
			mixHash(ciphertext)
			return plaintext
		}

		const encryptAndHash = (plaintext: Uint8Array) => {
			const ciphertext = aesEncryptGCM(plaintext, cipherKey!, iv(), hash)
			mixHash(ciphertext)
			return ciphertext
		}

		// Independent responder processing of IK message 1: e, es, s, ss.
		mixHash(NOISE_WA_HEADER)
		mixHash(responderStatic.public)
		mixHash(hello.ephemeral!)
		mixKey(Curve.sharedKey(responderStatic.private, hello.ephemeral!))
		const decodedInitiatorStatic = decryptAndHash(hello.static!)
		expect(decodedInitiatorStatic).toEqual(Buffer.from(initiatorStatic.public))
		mixKey(Curve.sharedKey(responderStatic.private, decodedInitiatorStatic))
		expect(decryptAndHash(hello.payload!)).toEqual(clientPayload)

		// Independent responder construction of IK message 2: e, ee, se.
		const responderEphemeral = Curve.generateKeyPair()
		mixHash(responderEphemeral.public)
		mixKey(Curve.sharedKey(responderEphemeral.private, hello.ephemeral!))
		mixKey(Curve.sharedKey(responderEphemeral.private, decodedInitiatorStatic))
		const responsePayload = Buffer.from('server-finished')
		const decodedResponse = handler.processIKServerHello(
			proto.HandshakeMessage.fromObject({
				serverHello: {
					ephemeral: responderEphemeral.public,
					payload: encryptAndHash(responsePayload)
				}
			})
		)
		expect(decodedResponse).toEqual(responsePayload)

		await handler.finishInit()
		const split = hkdf(Buffer.alloc(0), 64, { salt, info: '' })
		const encryptedTransportFrame = handler.encrypt(Buffer.from('transport-data'))
		expect(aesDecryptGCM(encryptedTransportFrame, split.subarray(0, 32), Buffer.alloc(12), Buffer.alloc(0))).toEqual(
			Buffer.from('transport-data')
		)
	})

	it('matches the captured official Android ED routing and WA Noise intro bytes', () => {
		const routingInfo = Buffer.from('08020812080d', 'hex')
		const payload = Buffer.from([0x12, 0x97, 0x03])
		const handler = makeNoiseHandler({
			keyPair: Curve.generateKeyPair(),
			NOISE_HEADER: NOISE_WA_HEADER,
			logger: createMockLogger() as any,
			routingInfo
		})

		const encoded = handler.encodeFrame(payload)

		expect(encoded.subarray(0, 4)).toEqual(Buffer.from([0x45, 0x44, 0x00, 0x01]))
		expect(encoded.subarray(4, 7)).toEqual(Buffer.from([0x00, 0x00, 0x06]))
		expect(encoded.subarray(7, 13)).toEqual(routingInfo)
		expect(encoded.subarray(13, 17)).toEqual(Buffer.from([0x57, 0x41, 0x06, 0x03]))
		expect(encoded.subarray(17, 20)).toEqual(Buffer.from([0x00, 0x00, payload.length]))
		expect(encoded.subarray(20)).toEqual(payload)
	})

	describe('decodeFrame with multiple frames in buffer', () => {
		it('should process multiple unencrypted frames in single buffer', async () => {
			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			const payload1 = Buffer.from([1, 2, 3, 4, 5])
			const payload2 = Buffer.from([6, 7, 8, 9, 10])

			const frame1 = createFrame(payload1)
			const frame2 = createFrame(payload2)

			const combinedBuffer = Buffer.concat([frame1, frame2])

			const receivedFrames: Buffer[] = []
			const onFrame = (frame: Uint8Array | BinaryNode) => {
				receivedFrames.push(Buffer.from(frame as Uint8Array))
			}

			await handler.decodeFrame(combinedBuffer, onFrame)

			expect(receivedFrames).toHaveLength(2)
			expect(receivedFrames[0]).toEqual(payload1)
			expect(receivedFrames[1]).toEqual(payload2)
		})

		it('should handle frames split across multiple decodeFrame calls', async () => {
			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
			const frame = createFrame(payload)

			const receivedFrames: Buffer[] = []
			const onFrame = (frame: Uint8Array | BinaryNode) => {
				receivedFrames.push(Buffer.from(frame as Uint8Array))
			}

			// Split the frame across two calls
			const part1 = frame.slice(0, 5)
			const part2 = frame.slice(5)

			await handler.decodeFrame(part1, onFrame)
			expect(receivedFrames).toHaveLength(0)

			await handler.decodeFrame(part2, onFrame)
			expect(receivedFrames).toHaveLength(1)
			expect(receivedFrames[0]).toEqual(payload)
		})

		it('should correctly process frames when callback triggers async operations', async () => {
			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			const payload1 = Buffer.from([1, 2, 3])
			const payload2 = Buffer.from([4, 5, 6])

			const combinedBuffer = Buffer.concat([createFrame(payload1), createFrame(payload2)])

			const receivedFrames: Buffer[] = []
			const callbackOrder: number[] = []

			const onFrame = (frame: Uint8Array | BinaryNode) => {
				const frameNum = receivedFrames.length + 1
				callbackOrder.push(frameNum)
				receivedFrames.push(Buffer.from(frame as Uint8Array))
			}

			await handler.decodeFrame(combinedBuffer, onFrame)

			expect(receivedFrames).toHaveLength(2)
			expect(callbackOrder).toEqual([1, 2])
			expect(receivedFrames[0]).toEqual(payload1)
			expect(receivedFrames[1]).toEqual(payload2)
		})
	})

	describe('encrypted frame handling', () => {
		it('should encrypt and verify frame structure', async () => {
			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			await handler.finishInit()

			const payload = Buffer.from('test payload')
			const encoded = handler.encodeFrame(payload)

			expect(encoded.length).toBeGreaterThan(payload.length + 3)

			const encoded2 = handler.encodeFrame(Buffer.from('second payload'))
			expect(encoded2.slice(0, 3)).toEqual(Buffer.from([0, 0, encoded2.length - 3]))
		})

		it('should produce different ciphertext for same plaintext due to counter', async () => {
			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			await handler.finishInit()

			const payload = Buffer.from('same payload')

			const encrypted1 = handler.encrypt(payload)
			const encrypted2 = handler.encrypt(payload)
			const encrypted3 = handler.encrypt(payload)

			expect(encrypted1).not.toEqual(encrypted2)
			expect(encrypted2).not.toEqual(encrypted3)
			expect(encrypted1).not.toEqual(encrypted3)
		})
	})

	describe('race condition scenario - concurrent decodeFrame calls', () => {
		it('should handle concurrent decodeFrame calls without corrupting inBytes buffer', async () => {
			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			// Create multiple frames
			const payloads = Array.from({ length: 5 }, (_, i) => Buffer.from(`payload-${i}`))
			const frames = payloads.map(createFrame)

			const receivedFrames: Buffer[] = []
			const onFrame = (frame: Uint8Array | BinaryNode) => {
				receivedFrames.push(Buffer.from(frame as Uint8Array))
			}

			// Simulate concurrent calls (multiple WebSocket messages arriving rapidly)
			// This tests the shared inBytes buffer handling
			await Promise.all(frames.map(frame => handler.decodeFrame(frame, onFrame)))

			// All frames should be received
			expect(receivedFrames).toHaveLength(5)

			// Verify all payloads are present (order may vary due to concurrency)
			const receivedPayloads = receivedFrames.map(f => f.toString())
			payloads.forEach(p => {
				expect(receivedPayloads).toContain(p.toString())
			})
		})

		it('should maintain counter integrity with many frames in single buffer', async () => {
			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			// Create 10 frames to stress test the while loop
			const payloads = Array.from({ length: 10 }, (_, i) => Buffer.from(`frame-${i}-payload-data`))

			const combinedBuffer = Buffer.concat(payloads.map(createFrame))

			const receivedFrames: Buffer[] = []
			const onFrame = (frame: Uint8Array | BinaryNode) => {
				receivedFrames.push(Buffer.from(frame as Uint8Array))
			}

			await handler.decodeFrame(combinedBuffer, onFrame)

			expect(receivedFrames).toHaveLength(10)
			payloads.forEach((payload, i) => {
				expect(receivedFrames[i]).toEqual(payload)
			})
		})
	})

	describe('encrypted frame race condition', () => {
		it('should produce different ciphertext for same plaintext due to counter', async () => {
			// Verify that encryption uses incrementing counters

			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			await handler.finishInit()

			const payload1 = Buffer.from('message-1')
			const payload2 = Buffer.from('message-2')

			const encrypted1 = handler.encrypt(payload1)
			const encrypted2 = handler.encrypt(payload2)

			expect(encrypted1.length).toBe(payload1.length + 16) // +16 for GCM tag
			expect(encrypted2.length).toBe(payload2.length + 16)

			// The encrypted data should be different (different counters used)
			expect(encrypted1).not.toEqual(encrypted2)
		})

		it('should serialize concurrent decodeFrame calls (fix for race condition)', async () => {
			// This test verifies that the lock mechanism correctly serializes
			// concurrent decodeFrame calls, preventing race conditions

			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			const payload1 = Buffer.from('first')
			const payload2 = Buffer.from('second')
			const payload3 = Buffer.from('third')

			const frame1 = createFrame(payload1)
			const frame2 = createFrame(payload2)
			const frame3 = createFrame(payload3)

			const receivedOrder: string[] = []

			const onFrame = (frame: Uint8Array | BinaryNode) => {
				const content = Buffer.from(frame as Uint8Array).toString()
				receivedOrder.push(content)
			}

			// Start all three decodeFrame calls "simultaneously"
			// With the lock fix, they should be processed in order
			const p1 = handler.decodeFrame(frame1, onFrame)
			const p2 = handler.decodeFrame(frame2, onFrame)
			const p3 = handler.decodeFrame(frame3, onFrame)

			await Promise.all([p1, p2, p3])

			// With serialization, frames should be received in the order
			// the decodeFrame calls were made
			expect(receivedOrder).toHaveLength(3)
			expect(receivedOrder[0]).toBe('first')
			expect(receivedOrder[1]).toBe('second')
			expect(receivedOrder[2]).toBe('third')
		})

		it('should maintain frame order with interleaved partial frames after fix', async () => {
			// This test verifies that partial frames from different sources
			// are correctly reassembled when calls are serialized

			const keyPair = Curve.generateKeyPair()
			const logger = createMockLogger()

			const handler = makeNoiseHandler({
				keyPair,
				NOISE_HEADER: NOISE_WA_HEADER,
				logger: logger as any
			})

			// Create a single frame split into parts
			const payload = Buffer.from('complete-message-content')
			const frame = createFrame(payload)

			const part1 = frame.slice(0, 10)
			const part2 = frame.slice(10)

			const receivedFrames: Buffer[] = []
			const onFrame = (frame: Uint8Array | BinaryNode) => {
				receivedFrames.push(Buffer.from(frame as Uint8Array))
			}

			// With serialization, these should be processed in order
			// and the frame should be correctly reassembled
			await handler.decodeFrame(part1, onFrame)
			expect(receivedFrames).toHaveLength(0) // Not complete yet

			await handler.decodeFrame(part2, onFrame)
			expect(receivedFrames).toHaveLength(1)
			expect(receivedFrames[0]).toEqual(payload)
		})
	})
})
