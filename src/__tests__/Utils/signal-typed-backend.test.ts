/**
 * Phase 9.5 — `SignalTypedBackend` smoke tests.
 *
 * Covers session / prekey / signed_prekey / kyber_prekey / identity /
 * sender_key round-trip on the typed Signal Protocol tables. Identity
 * dual-storage by `recipient_type` (LID vs PN) is exercised explicitly.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore, SignalTypedBackend } from '../../Utils/multi-db-sqlite'

describe('SignalTypedBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'signal-typed-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('round-trips a session by its 5-tuple natural key', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const key = {
			deviceId: 1,
			recipientAccountId: '46802258641027@lid',
			recipientAccountType: 1,
			sessionType: 0,
			sessionScope: 0
		}
		backend.putSession(key, Buffer.from([0xaa, 0xbb, 0xcc]), 1_000)

		const got = backend.getSession(key)
		expect(got).not.toBeNull()
		expect(Buffer.from(got!.record).toString('hex')).toBe('aabbcc')
		expect(got!.timestamp).toBe(1_000)

		expect(backend.deleteSession(key)).toBe(true)
		expect(backend.getSession(key)).toBeNull()
	})

	it('round-trips a prekey, signed_prekey, and kyber_prekey', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		backend.putPrekey(101, Buffer.from([1]))
		backend.putSignedPrekey(202, Buffer.from([2]), 50_000)
		backend.putKyberPrekey(303, Buffer.from([3]), true)

		expect(Buffer.from(backend.getPrekey(101)!).toString('hex')).toBe('01')
		expect(Buffer.from(backend.getSignedPrekey(202)!.record).toString('hex')).toBe('02')
		const kyber = backend.getKyberPrekey(303)
		expect(Buffer.from(kyber!.record).toString('hex')).toBe('03')
		expect(kyber!.lastResortKey).toBe(true)

		expect(backend.deletePrekey(101)).toBe(true)
		expect(backend.getPrekey(101)).toBeNull()
	})

	it('stores an identity by both LID and PN recipient_type independently', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		// recipient_id is INTEGER per the schema — use stable numeric ids
		const pnKey = { recipientId: 5515991426667, recipientType: 0, deviceId: 0 }
		const lidKey = { recipientId: 46802258641027, recipientType: 1, deviceId: 0 }

		backend.putIdentity(pnKey, Buffer.from([0xee]), 100)
		backend.putIdentity(lidKey, Buffer.from([0xff]), 200)

		const pn = backend.getIdentity(pnKey)
		const lid = backend.getIdentity(lidKey)
		expect(Buffer.from(pn!.publicKey).toString('hex')).toBe('ee')
		expect(Buffer.from(lid!.publicKey).toString('hex')).toBe('ff')
		expect(pn!.timestamp).toBe(100)
		expect(lid!.timestamp).toBe(200)
	})

	it('round-trips a sender_key', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const key = {
			groupId: '120363044055005321@g.us',
			deviceId: 0,
			senderAccountId: '5515991426667',
			senderAccountType: 0
		}
		backend.putSenderKey(key, Buffer.from([0x55, 0x66]), 999)

		const got = backend.getSenderKey(key)
		expect(Buffer.from(got!.record).toString('hex')).toBe('5566')
		expect(got!.timestamp).toBe(999)
	})
})
