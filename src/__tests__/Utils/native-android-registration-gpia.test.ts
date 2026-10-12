import {
	buildWamsysGpiaBlob,
	mintWamsysGpiaBlob,
	NATIVE_ANDROID_GPIA_LEG_PREFIX,
	NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH,
	NATIVE_ANDROID_GPIA_SIGNATURE_LENGTH,
	parseWamsysGpiaBlob
} from '../../Utils/native-android-registration-gpia'

/**
 * Structural replica of the official blob (same shape, synthetic contents):
 * protobuf field1 LEN 231B + field3 LEN 63B, both legs prefixed `0x01`,
 * base64url without padding. The real captured artifact is deployment
 * material (env `NATIVE_ANDROID_REGISTRATION_GPIA`) and never enters the repo.
 */
const structuralReplica = (): string => {
	const payload = new Uint8Array(NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH).fill(0xa7)
	payload[0] = NATIVE_ANDROID_GPIA_LEG_PREFIX
	const signature = new Uint8Array(NATIVE_ANDROID_GPIA_SIGNATURE_LENGTH).fill(0x5c)
	signature[0] = NATIVE_ANDROID_GPIA_LEG_PREFIX
	return buildWamsysGpiaBlob({ payload, signature })
}

describe('native android wamsys gpia blob', () => {
	it('encodes the official wire shape (299 bytes -> 399 base64url chars, no padding)', () => {
		const blob = structuralReplica()
		expect(blob).toHaveLength(399)
		expect(blob).not.toMatch(/[+/=]/)
		expect(Buffer.from(blob, 'base64url')).toHaveLength(299)
	})

	it('parses the two protobuf legs at their pinned offsets', () => {
		const { payload, signature } = parseWamsysGpiaBlob(structuralReplica())
		expect(payload).toHaveLength(231)
		expect(signature).toHaveLength(63)
		expect(payload[0]).toBe(NATIVE_ANDROID_GPIA_LEG_PREFIX)
		expect(signature[0]).toBe(NATIVE_ANDROID_GPIA_LEG_PREFIX)
		expect(payload[1]).toBe(0xa7)
		expect(signature[1]).toBe(0x5c)
	})

	it('round-trips byte-for-byte through parse/build', () => {
		const blob = structuralReplica()
		expect(buildWamsysGpiaBlob(parseWamsysGpiaBlob(blob))).toBe(blob)
	})

	it('rejects the foreign artifacts the gate also rejects', () => {
		// Play Integrity Standard JWS: dotted, ~558 chars — not a wamsys blob.
		expect(() => parseWamsysGpiaBlob('a'.repeat(100) + '.' + 'b'.repeat(100) + '.' + 'c'.repeat(100))).toThrow()
		expect(() => parseWamsysGpiaBlob('a'.repeat(398))).toThrow(/299 bytes/)
		expect(() =>
			parseWamsysGpiaBlob(buildWamsysGpiaBlob({ payload: new Uint8Array(231), signature: new Uint8Array(62) }))
		).toThrow(/63 bytes/)
	})

	it('mints deterministically per seed and never collides across seeds', () => {
		const seedA = new Uint8Array([1, 2, 3, 4])
		const seedB = new Uint8Array([1, 2, 3, 5])
		const first = mintWamsysGpiaBlob(seedA)
		expect(mintWamsysGpiaBlob(seedA)).toBe(first)
		expect(mintWamsysGpiaBlob(seedB)).not.toBe(first)
		expect(first).toHaveLength(399)
		const { payload, signature } = parseWamsysGpiaBlob(first)
		expect(payload[0]).toBe(NATIVE_ANDROID_GPIA_LEG_PREFIX)
		expect(signature[0]).toBe(NATIVE_ANDROID_GPIA_LEG_PREFIX)
		// High-entropy legs: derived bytes, never a zero block.
		expect(payload.slice(1).every(byte => byte === 0)).toBe(false)
		expect(signature.slice(1).every(byte => byte === 0)).toBe(false)
	})

	it('pins field 1 to a payload template while still minting field 3', () => {
		const template = new Uint8Array(NATIVE_ANDROID_GPIA_PAYLOAD_LENGTH).fill(0x31)
		template[0] = NATIVE_ANDROID_GPIA_LEG_PREFIX
		const blob = mintWamsysGpiaBlob(new Uint8Array([9, 9, 9]), { payloadTemplate: template })
		const { payload, signature } = parseWamsysGpiaBlob(blob)
		expect(payload).toEqual(template)
		expect(signature[0]).toBe(NATIVE_ANDROID_GPIA_LEG_PREFIX)
		expect(signature.slice(1).every(byte => byte === 0x31)).toBe(false)
		expect(() =>
			mintWamsysGpiaBlob(new Uint8Array([1]), { payloadTemplate: new Uint8Array(230) })
		).toThrow(/payload template/)
	})

	it('refuses an empty seed', () => {
		expect(() => mintWamsysGpiaBlob(new Uint8Array(0))).toThrow(/seed/)
	})
})
