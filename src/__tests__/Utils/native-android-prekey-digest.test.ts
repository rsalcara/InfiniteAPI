import { createHash } from 'crypto'
import {
	computeNativeAndroidPreKeyDigestHash,
	type NativeAndroidPreKeyDigestLocalState,
	parseNativeAndroidPreKeyDigestNode,
	verifyNativeAndroidPreKeyDigest
} from '../../Utils/native-android-prekey-digest'
import type { BinaryNode } from '../../WABinary'

const be = (value: number, width: number): Buffer => {
	const buf = Buffer.alloc(width)
	buf.writeUIntBE(value, 0, width)
	return buf
}

const leaf = (tag: string, content: Buffer): BinaryNode => ({ tag, attrs: {}, content })
const node = (tag: string, content: BinaryNode[]): BinaryNode => ({ tag, attrs: {}, content })

const key = (seed: number) => Buffer.alloc(32, seed)
const sig = Buffer.alloc(64, 0xab)

const localState = (
	overrides: Partial<NativeAndroidPreKeyDigestLocalState> = {}
): NativeAndroidPreKeyDigestLocalState => ({
	registrationId: 12_345,
	signedPreKeyId: 7,
	identityPublicKey: key(1),
	signedPreKeyPublic: key(2),
	signedPreKeySignature: sig,
	preKeys: new Map([
		[100, key(3)],
		[101, key(4)],
		[102, key(5)]
	]),
	...overrides
})

const classicDigestNode = (state: NativeAndroidPreKeyDigestLocalState, serverPreKeyIds: number[]): BinaryNode => {
	const hash = computeNativeAndroidPreKeyDigestHash(state, serverPreKeyIds)
	return node('digest', [
		leaf('registration', be(state.registrationId, 4)),
		leaf('type', Buffer.from([5])),
		node('skey', [leaf('id', be(state.signedPreKeyId, 3))]),
		node(
			'list',
			serverPreKeyIds.map(id => leaf('id', be(id, 3)))
		),
		leaf('hash', Buffer.from(hash))
	])
}

describe('native-android-prekey-digest — official onGetPreKeyDigest (DT6) contract', () => {
	it('parses the classic digest node 1:1 (fixed-width big-endian fields)', () => {
		const state = localState()
		const parsed = parseNativeAndroidPreKeyDigestNode(classicDigestNode(state, [102, 100]))
		expect(parsed).not.toBeNull()
		expect(parsed!.type).toBe(5)
		expect(parsed!.registrationId).toBe(12_345)
		expect(parsed!.signedPreKeyId).toBe(7)
		expect(parsed!.serverPreKeyIds).toEqual([102, 100])
		expect(parsed!.hash.length).toBe(20)
		expect(parsed!.pqPreKeyIds).toBeNull()
		expect(parsed!.pqLastResortKeyId).toBeNull()
	})

	it('rejects malformed digests (missing child, wrong width, empty list entry)', () => {
		const state = localState()
		const good = classicDigestNode(state, [100]) as BinaryNode & { content: BinaryNode[] }

		const withoutHash = node(
			'digest',
			good.content.filter(child => child.tag !== 'hash')
		)
		expect(parseNativeAndroidPreKeyDigestNode(withoutHash)).toBeNull()

		const shortRegistration = node('digest', [
			leaf('registration', be(1, 3)),
			leaf('type', Buffer.from([5])),
			node('skey', [leaf('id', be(7, 3))]),
			node('list', [leaf('id', be(100, 3))]),
			leaf('hash', Buffer.alloc(20))
		])
		expect(parseNativeAndroidPreKeyDigestNode(shortRegistration)).toBeNull()

		const badListEntry = node('digest', [
			leaf('registration', be(12_345, 4)),
			leaf('type', Buffer.from([5])),
			node('skey', [leaf('id', be(7, 3))]),
			node('list', [leaf('id', be(100, 2))]),
			leaf('hash', Buffer.alloc(20))
		])
		expect(parseNativeAndroidPreKeyDigestNode(badListEntry)).toBeNull()

		expect(parseNativeAndroidPreKeyDigestNode(undefined)).toBeNull()
	})

	it('parses the pq variant only with the matching 32-byte hash (DT6 width rule)', () => {
		const state = localState()
		const pqNode = node('digest', [
			leaf('registration', be(state.registrationId, 4)),
			leaf('type', Buffer.from([5])),
			node('skey', [leaf('id', be(state.signedPreKeyId, 3))]),
			node('list', [leaf('id', be(100, 3))]),
			leaf('hash', Buffer.alloc(32)),
			node('pq_list', [leaf('id', be(500, 3))]),
			node('pq_last_resort_key', [leaf('id', be(501, 3))])
		])
		const parsed = parseNativeAndroidPreKeyDigestNode(pqNode)
		expect(parsed).not.toBeNull()
		expect(parsed!.pqLastResortKeyId).toBe(501)
		expect(parsed!.pqPreKeyIds).toEqual([500])
		expect(parsed!.hash.length).toBe(32)

		const classicHashWithPq = node('digest', [
			leaf('registration', be(state.registrationId, 4)),
			leaf('type', Buffer.from([5])),
			node('skey', [leaf('id', be(state.signedPreKeyId, 3))]),
			node('list', [leaf('id', be(100, 3))]),
			leaf('hash', Buffer.alloc(20)),
			node('pq_last_resort_key', [leaf('id', be(501, 3))])
		])
		expect(parseNativeAndroidPreKeyDigestNode(classicHashWithPq)).toBeNull()
	})

	it('hashes identity || skey pub || skey sig || prekey pubs in SERVER-LIST order (SHA1)', () => {
		const state = localState()
		const serverOrder = [102, 100, 101]
		const expected = createHash('sha1')
			.update(state.identityPublicKey)
			.update(state.signedPreKeyPublic)
			.update(state.signedPreKeySignature)
			.update(key(5))
			.update(key(3))
			.update(key(4))
			.digest()
		expect(Buffer.from(computeNativeAndroidPreKeyDigestHash(state, serverOrder)).equals(expected)).toBe(true)

		// Order matters: the same ids in a different order produce a different hash.
		const other = computeNativeAndroidPreKeyDigestHash(state, [100, 101, 102])
		expect(Buffer.from(other).equals(expected)).toBe(false)
	})

	it('passes a matching digest and fails each divergence with the official A0O code', () => {
		const state = localState()
		const serverIds = [100, 101, 102]

		const ok = verifyNativeAndroidPreKeyDigest(
			parseNativeAndroidPreKeyDigestNode(classicDigestNode(state, serverIds)),
			state
		)
		expect(ok).toEqual({ ok: true })

		const registrationDiverged = verifyNativeAndroidPreKeyDigest(
			parseNativeAndroidPreKeyDigestNode(classicDigestNode({ ...state, registrationId: 99 }, serverIds)),
			state
		)
		expect(registrationDiverged).toMatchObject({ ok: false, reason: 'registration-mismatch', officialCode: 5 })

		const skeyDiverged = verifyNativeAndroidPreKeyDigest(
			parseNativeAndroidPreKeyDigestNode(classicDigestNode({ ...state, signedPreKeyId: 8 }, serverIds)),
			state
		)
		expect(skeyDiverged).toMatchObject({ ok: false, reason: 'signed-pre-key-mismatch', officialCode: 3 })

		// 999 is not in the local store, so the helper cannot compute a real
		// hash — and it does not need to: DT6 checks list coverage before the
		// hash, so any 20-byte placeholder reaches that verdict.
		const nodeListingMissingKey = node('digest', [
			leaf('registration', be(state.registrationId, 4)),
			leaf('type', Buffer.from([5])),
			node('skey', [leaf('id', be(state.signedPreKeyId, 3))]),
			node('list', [leaf('id', be(100, 3)), leaf('id', be(999, 3))]),
			leaf('hash', Buffer.alloc(20))
		])
		const missingLocal = verifyNativeAndroidPreKeyDigest(
			parseNativeAndroidPreKeyDigestNode(nodeListingMissingKey),
			state
		)
		expect(missingLocal).toMatchObject({ ok: false, reason: 'missing-local-pre-key', officialCode: 3 })

		const nodeWithWrongHash = node('digest', [
			leaf('registration', be(state.registrationId, 4)),
			leaf('type', Buffer.from([5])),
			node('skey', [leaf('id', be(state.signedPreKeyId, 3))]),
			node(
				'list',
				serverIds.map(id => leaf('id', be(id, 3)))
			),
			leaf('hash', Buffer.alloc(20, 0xff))
		])
		const hashDiverged = verifyNativeAndroidPreKeyDigest(parseNativeAndroidPreKeyDigestNode(nodeWithWrongHash), state)
		expect(hashDiverged).toMatchObject({ ok: false, reason: 'hash-mismatch', officialCode: 3 })

		expect(verifyNativeAndroidPreKeyDigest(null, state)).toMatchObject({
			ok: false,
			reason: 'malformed-digest',
			officialCode: 12
		})

		const wrongType = node('digest', [
			leaf('registration', be(state.registrationId, 4)),
			leaf('type', Buffer.from([4])),
			node('skey', [leaf('id', be(state.signedPreKeyId, 3))]),
			node(
				'list',
				serverIds.map(id => leaf('id', be(id, 3)))
			),
			leaf('hash', Buffer.alloc(20))
		])
		expect(verifyNativeAndroidPreKeyDigest(parseNativeAndroidPreKeyDigestNode(wrongType), state)).toMatchObject({
			ok: false,
			reason: 'malformed-digest',
			officialCode: 3
		})
	})

	it('fails the pq variant instead of comparing a hash it cannot reproduce', () => {
		const state = localState()
		const pqNode = node('digest', [
			leaf('registration', be(state.registrationId, 4)),
			leaf('type', Buffer.from([5])),
			node('skey', [leaf('id', be(state.signedPreKeyId, 3))]),
			node('list', [leaf('id', be(100, 3))]),
			leaf('hash', Buffer.alloc(32, 0xcd)),
			node('pq_last_resort_key', [leaf('id', be(501, 3))])
		])
		const verdict = verifyNativeAndroidPreKeyDigest(parseNativeAndroidPreKeyDigestNode(pqNode), state)
		expect(verdict).toMatchObject({ ok: false, reason: 'unsupported-pq-digest', officialCode: 5 })
	})
})
