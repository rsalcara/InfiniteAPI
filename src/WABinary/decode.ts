import { promisify } from 'util'
import { inflate } from 'zlib'
import * as constants from './constants'
import { jidEncode, type JidServer, WAJIDDomains } from './jid-utils'
import type { BinaryNode, BinaryNodeCodingOptions } from './types'

const inflatePromise = promisify(inflate)

/**
 * Cap on the decompressed payload size we will accept from the relay.
 * WhatsApp stanzas are tiny in practice (≤ 256 KiB even for big media
 * negotiation), so 16 MiB is several orders of magnitude above legitimate
 * traffic but tight enough to defuse a zlib bomb (a few KiB of crafted
 * deflate stream can otherwise expand to GiBs and OOM the process).
 *
 * The cap can be raised at runtime via `BAILEYS_MAX_DECOMPRESSED_NODE`
 * (bytes) for unusual deployments — set to 0/empty to disable.
 */
const MAX_DECOMPRESSED_NODE_BYTES = (() => {
	const raw = process.env.BAILEYS_MAX_DECOMPRESSED_NODE
	if (raw === '0' || raw === '') return Infinity
	const parsed = raw ? Number.parseInt(raw, 10) : NaN
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 16 * 1024 * 1024
})()

/**
 * Cap on how deep `decodeDecompressedBinaryNode` will recurse into nested
 * `readList`. Legitimate stanzas top out around 8 levels; 64 leaves comfortable
 * headroom while preventing a stack overflow from a crafted frame whose only
 * payload is an arbitrarily-deep list-of-lists.
 */
const MAX_NODE_DEPTH = 64

export const decompressingIfRequired = async (buffer: Buffer) => {
	if (2 & buffer.readUInt8()) {
		// `maxOutputLength` makes zlib abort with a clear `RangeError` instead
		// of growing the output buffer unboundedly. Without it, the inflated
		// stanza is a DoS primitive — the relay is hostile-trustless.
		buffer = await inflatePromise(buffer.slice(1), {
			maxOutputLength: Number.isFinite(MAX_DECOMPRESSED_NODE_BYTES) ? MAX_DECOMPRESSED_NODE_BYTES : undefined
		})
	} else {
		// nodes with no compression have a 0x00 prefix, we remove that
		buffer = buffer.slice(1)
	}

	return buffer
}

export const decodeDecompressedBinaryNode = (
	buffer: Buffer,
	opts: Pick<BinaryNodeCodingOptions, 'DOUBLE_BYTE_TOKENS' | 'SINGLE_BYTE_TOKENS' | 'TAGS'>,
	indexRef: { index: number } = { index: 0 },
	depth: number = 0
): BinaryNode => {
	// Depth guard — a crafted frame whose payload is just a list-of-lists
	// recurses one level per byte. Without this guard the stack overflows
	// long before the buffer is exhausted, crashing the socket.
	if (depth > MAX_NODE_DEPTH) {
		throw new Error(`max node depth exceeded (${MAX_NODE_DEPTH})`)
	}

	const { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } = opts

	const checkEOS = (length: number) => {
		if (indexRef.index + length > buffer.length) {
			throw new Error('end of stream')
		}
	}

	const next = () => {
		const value = buffer[indexRef.index]
		indexRef.index += 1
		return value
	}

	const readByte = () => {
		checkEOS(1)
		return next()
	}

	const readBytes = (n: number) => {
		checkEOS(n)
		const value = buffer.slice(indexRef.index, indexRef.index + n)
		indexRef.index += n
		return value
	}

	const readStringFromChars = (length: number) => {
		return readBytes(length).toString('utf-8')
	}

	const readInt = (n: number, littleEndian = false) => {
		checkEOS(n)
		let val = 0
		for (let i = 0; i < n; i++) {
			const shift = littleEndian ? i : n - 1 - i
			// Intentional bitwise OR — the WhatsApp binary protocol caps
			// these widths at 4 bytes, so the implicit i32-with-sign coercion
			// from `|=` is fine. A 4-byte length here with the high bit set
			// would have been a length > 2 GB, which is rejected upstream by
			// `checkEOS`. (audit P3-WAB-01)
			val |= next()! << (shift * 8)
		}

		return val
	}

	const readInt20 = () => {
		checkEOS(3)
		return ((next()! & 15) << 16) + (next()! << 8) + next()!
	}

	const unpackHex = (value: number) => {
		if (value >= 0 && value < 16) {
			return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10
		}

		throw new Error('invalid hex: ' + value)
	}

	const unpackNibble = (value: number) => {
		if (value >= 0 && value <= 9) {
			return '0'.charCodeAt(0) + value
		}

		switch (value) {
			case 10:
				return '-'.charCodeAt(0)
			case 11:
				return '.'.charCodeAt(0)
			case 15:
				return '\0'.charCodeAt(0)
			default:
				throw new Error('invalid nibble: ' + value)
		}
	}

	const unpackByte = (tag: number, value: number) => {
		if (tag === TAGS.NIBBLE_8) {
			return unpackNibble(value)
		} else if (tag === TAGS.HEX_8) {
			return unpackHex(value)
		} else {
			throw new Error('unknown tag: ' + tag)
		}
	}

	const readPacked8 = (tag: number) => {
		const startByte = readByte()!
		let value = ''

		for (let i = 0; i < (startByte & 127); i++) {
			const curByte = readByte()!

			value += String.fromCharCode(unpackByte(tag, (curByte & 0xf0) >> 4))
			value += String.fromCharCode(unpackByte(tag, curByte & 0x0f))
		}

		if (startByte >> 7 !== 0) {
			value = value.slice(0, -1)
		}

		return value
	}

	const isListTag = (tag: number) => {
		return tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16
	}

	const readListSize = (tag: number) => {
		switch (tag) {
			case TAGS.LIST_EMPTY:
				return 0
			case TAGS.LIST_8:
				return readByte()
			case TAGS.LIST_16:
				return readInt(2)
			default:
				throw new Error('invalid tag for list size: ' + tag)
		}
	}

	const readJidPair = () => {
		const i = readString(readByte()!)
		const j = readString(readByte()!)
		if (j) {
			return (i || '') + '@' + j
		}

		throw new Error('invalid jid pair: ' + i + ', ' + j)
	}

	const readAdJid = () => {
		const rawDomainType = readByte()
		const domainType = Number(rawDomainType)

		const device = readByte()
		const user = readString(readByte()!)

		let server: JidServer = 's.whatsapp.net' // default whatsapp server
		if (domainType === WAJIDDomains.LID) {
			server = 'lid'
		} else if (domainType === WAJIDDomains.HOSTED) {
			server = 'hosted'
		} else if (domainType === WAJIDDomains.HOSTED_LID) {
			server = 'hosted.lid'
		}

		return jidEncode(user, server, device)
	}

	const readFbJid = () => {
		const user = readString(readByte()!)
		const device = readInt(2)
		const server = readString(readByte()!)
		return `${user}:${device}@${server}`
	}

	const readInteropJid = () => {
		const user = readString(readByte()!)
		const device = readInt(2)
		const integrator = readInt(2)

		let server = 'interop'
		const beforeServer = indexRef.index
		try {
			server = readString(readByte()!)
		} catch (err) {
			indexRef.index = beforeServer
		}

		return `${integrator}-${user}:${device}@${server}`
	}

	const readString = (tag: number): string => {
		if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
			return SINGLE_BYTE_TOKENS[tag] || ''
		}

		switch (tag) {
			case TAGS.DICTIONARY_0:
			case TAGS.DICTIONARY_1:
			case TAGS.DICTIONARY_2:
			case TAGS.DICTIONARY_3:
				return getTokenDouble(tag - TAGS.DICTIONARY_0, readByte()!)
			case TAGS.LIST_EMPTY:
				return ''
			case TAGS.BINARY_8:
				return readStringFromChars(readByte()!)
			case TAGS.BINARY_20:
				return readStringFromChars(readInt20())
			case TAGS.BINARY_32:
				return readStringFromChars(readInt(4))
			case TAGS.JID_PAIR:
				return readJidPair()
			case TAGS.FB_JID:
				return readFbJid()
			case TAGS.INTEROP_JID:
				return readInteropJid()
			case TAGS.AD_JID:
				return readAdJid()
			case TAGS.HEX_8:
			case TAGS.NIBBLE_8:
				return readPacked8(tag)
			default:
				throw new Error('invalid string with tag: ' + tag)
		}
	}

	const readList = (tag: number) => {
		const items: BinaryNode[] = []
		const size = readListSize(tag)!
		for (let i = 0; i < size; i++) {
			items.push(decodeDecompressedBinaryNode(buffer, opts, indexRef, depth + 1))
		}

		return items
	}

	const getTokenDouble = (index1: number, index2: number) => {
		const dict = DOUBLE_BYTE_TOKENS[index1]
		if (!dict) {
			throw new Error(`Invalid double token dict (${index1})`)
		}

		const value = dict[index2]
		if (typeof value === 'undefined') {
			throw new Error(`Invalid double token (${index2})`)
		}

		return value
	}

	const listSize = readListSize(readByte()!)
	const header = readString(readByte()!)
	if (!listSize || !header.length) {
		throw new Error('invalid node')
	}

	// Prototype-less object: `attrs` keys come straight from the wire and
	// would otherwise let an attacker pollute Object.prototype / shadow
	// inherited members (`__proto__`, `constructor`, `toString`) on every
	// node we hand to user code. (audit P2-WAB-01)
	const attrs: BinaryNode['attrs'] = Object.create(null)
	let data: BinaryNode['content']
	if (listSize === 0 || !header) {
		throw new Error('invalid node')
	}

	// read the attributes in
	const attributesLength = (listSize - 1) >> 1
	for (let i = 0; i < attributesLength; i++) {
		const key = readString(readByte()!)
		const value = readString(readByte()!)

		attrs[key] = value
	}

	if (listSize % 2 === 0) {
		const tag = readByte()!
		if (isListTag(tag)) {
			data = readList(tag)
		} else {
			let decoded: Buffer | string
			switch (tag) {
				case TAGS.BINARY_8:
					decoded = readBytes(readByte()!)
					break
				case TAGS.BINARY_20:
					decoded = readBytes(readInt20())
					break
				case TAGS.BINARY_32:
					decoded = readBytes(readInt(4))
					break
				default:
					decoded = readString(tag)
					break
			}

			data = decoded
		}
	}

	return {
		tag: header,
		attrs,
		content: data
	}
}

export const decodeBinaryNode = async (buff: Buffer): Promise<BinaryNode> => {
	const decompBuff = await decompressingIfRequired(buff)
	return decodeDecompressedBinaryNode(decompBuff, constants)
}
