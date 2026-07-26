import $protobuf from 'protobufjs/minimal.js'
import { createFastRatchetSenderKeyState, encodeFastRatchetSenderKeyDistribution } from '../../Signal/fast-ratchet'

const decodeFields = (value: Uint8Array) => {
	const reader = $protobuf.Reader.create(value)
	const fields: Array<{ field: number; wire: number; value: number | Uint8Array }> = []
	while (reader.pos < reader.len) {
		const tag = reader.uint32()
		const field = tag >>> 3
		const wire = tag & 7
		fields.push({ field, wire, value: wire === 2 ? reader.bytes() : reader.uint32() })
	}

	return fields
}

describe('Android fast-ratchet live-location wire format', () => {
	it('encodes the A4M distribution as 0x33 + id/iteration/8 chains/signing key', () => {
		const state = createFastRatchetSenderKeyState()
		const encoded = encodeFastRatchetSenderKeyDistribution(state)
		expect(encoded[0]).toBe(0x33)

		const fields = decodeFields(encoded.subarray(1))
		expect(fields.filter(field => field.field === 1).map(field => field.value)).toEqual([state.senderKeyId])
		expect(fields.filter(field => field.field === 2).map(field => field.value)).toEqual([0])
		const chains = fields.filter(field => field.field === 3).map(field => field.value as Uint8Array)
		expect(chains).toHaveLength(8)
		expect(chains[0]).toHaveLength(32)
		expect(chains.slice(1).every(chain => chain.length === 0)).toBe(true)
		expect(fields.find(field => field.field === 4)?.value).toHaveLength(33)
	})
})
