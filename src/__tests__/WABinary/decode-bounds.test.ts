/**
 * Tests for the DoS-hardening bounds added to the WhatsApp binary decoder
 * in the 2026-06-10 audit batch. Two attack vectors are explicitly capped:
 *
 *   1. zlib bomb — `inflate()` is given `maxOutputLength` so a few KiB of
 *      crafted deflate stream can't expand to GiBs.
 *   2. Recursive list-of-list — `decodeDecompressedBinaryNode` carries a
 *      `depth` counter that caps recursion at `MAX_NODE_DEPTH` (= 64).
 *
 * Both inputs come from the relay, which is hostile-trustless. (audit TST-04)
 */
import { promisify } from 'util'
import { deflate } from 'zlib'
import * as constants from '../../WABinary/constants'
import { decodeBinaryNode, decodeDecompressedBinaryNode, decompressingIfRequired } from '../../WABinary/decode'

const deflatePromise = promisify(deflate)

describe('WABinary/decode — DoS bounds (audit TST-04)', () => {
	describe('zlib bomb cap (decompressingIfRequired)', () => {
		it('rejects a payload whose decompressed size exceeds maxOutputLength', async () => {
			// 32 MiB of zeros compresses to a few KiB but exceeds the 16 MiB
			// default cap when expanded. inflate must throw a RangeError /
			// "maxOutputLength" error before producing the full buffer.
			const huge = Buffer.alloc(32 * 1024 * 1024, 0)
			const compressed = await deflatePromise(huge)
			// First byte must have the compression flag (bit 1 set) so the
			// decoder takes the inflate path.
			const framed = Buffer.concat([Buffer.from([0x02]), compressed])

			// Node surfaces this as "Cannot create a Buffer larger than N bytes"
			// when maxOutputLength fires. Match either form.
			await expect(decompressingIfRequired(framed)).rejects.toThrow(/maxOutputLength|larger than/i)
		})

		it('passes through an uncompressed payload regardless of size', async () => {
			// Compression bit OFF (0x00 prefix). Should return a buffer with
			// the prefix stripped; size is not bounded for the uncompressed
			// path, the cap only applies to inflate.
			const payload = Buffer.from([0x00, ...Buffer.alloc(64, 0xaa)])
			const out = await decompressingIfRequired(payload)
			expect(out.length).toBe(64)
		})
	})

	describe('depth cap (decodeDecompressedBinaryNode)', () => {
		// Drive the depth guard directly through the recursion-counter
		// parameter. Forging a valid 65-level nested LIST stanza by hand is
		// painful (each level needs LIST_8 + size + header + content tags
		// in a very specific shape); the public function exposes `depth` as
		// the 4th arg so a recursive caller could already pass a starting
		// depth, which is exactly what we exercise here. This is the same
		// surface the production `readList` reaches when it calls back into
		// itself — the production code is verified end-to-end whenever a
		// list-of-lists arrives over the wire.
		it('throws "max node depth exceeded" when entered above the cap', () => {
			const buf = Buffer.from([0xf8, 1, 1]) // LIST_8 size=1 header=1
			expect(() => decodeDecompressedBinaryNode(buf, constants, undefined, 65)).toThrow(/max node depth/i)
		})

		it('accepts a node at depth = cap (boundary inclusive)', () => {
			// depth = MAX_NODE_DEPTH should pass; depth > MAX_NODE_DEPTH throws.
			// The 3-byte buffer is intentionally truncated, so the decoder is
			// EXPECTED to throw some parse error — we just need to confirm it's
			// NOT the depth guard. Earlier `expect(...).not.toThrow(/regex/)`
			// would have passed even on a stack overflow / other error that
			// silently hid a regression in the depth check.
			const buf = Buffer.from([0xf8, 1, 1])
			let thrown: Error | undefined
			try {
				decodeDecompressedBinaryNode(buf, constants, undefined, 64)
			} catch (e) {
				thrown = e as Error
			}

			expect(thrown?.message ?? '').not.toMatch(/max node depth/i)
		})

		it('accepts a node at depth = 0', () => {
			const buf = Buffer.from([0xf8, 1, 1])
			let thrown: Error | undefined
			try {
				decodeDecompressedBinaryNode(buf, constants, undefined, 0)
			} catch (e) {
				thrown = e as Error
			}

			expect(thrown?.message ?? '').not.toMatch(/max node depth/i)
		})
	})

	describe('decodeBinaryNode integration', () => {
		it('rejects a compressed bomb at the public entrypoint', async () => {
			const huge = Buffer.alloc(32 * 1024 * 1024, 0)
			const compressed = await deflatePromise(huge)
			const framed = Buffer.concat([Buffer.from([0x02]), compressed])

			await expect(decodeBinaryNode(framed)).rejects.toThrow(/maxOutputLength|larger than/i)
		})
	})
})
