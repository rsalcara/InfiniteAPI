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

	it('appends prekey_uploads rows (one per upload batch)', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		backend.recordPrekeyUpload(1_000, 0)
		backend.recordPrekeyUpload(2_000, 0)

		const rows = store
			.handle('axolotl.db')
			.prepare('SELECT upload_timestamp, key_type FROM prekey_uploads ORDER BY _id')
			.all() as Array<{ upload_timestamp: number; key_type: number }>
		expect(rows.map(r => r.upload_timestamp)).toEqual([1_000, 2_000])
	})

	it('round-trips + deletes a message_base_key (dedupes on the natural key)', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const key = { remoteJid: '5515991426667.0', fromMe: true, msgId: 'MSG-BK-1' }

		backend.putMessageBaseKey(key, Buffer.from([0xba, 0x5e]), 500)
		expect(Buffer.from(backend.getMessageBaseKey(key)!.baseKey).toString('hex')).toBe('ba5e')

		// Upsert on the same natural key replaces (no duplicate row) — the
		// recipient_id sentinel keeps the unique index effective.
		backend.putMessageBaseKey(key, Buffer.from([0xff]), 600)
		const count = store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM message_base_key').get() as {
			n: number
		}
		expect(count.n).toBe(1)
		expect(Buffer.from(backend.getMessageBaseKey(key)!.baseKey).toString('hex')).toBe('ff')

		// Delete-on-ack removes it.
		expect(backend.deleteMessageBaseKey(key)).toBe(true)
		expect(backend.getMessageBaseKey(key)).toBeNull()
	})

	it('enqueues, bumps process_count, and drops an unordered_stanza_queue row', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const axolotl = store.handle('axolotl.db')
		const row = (id: string) =>
			axolotl.prepare('SELECT process_count, stanza_id FROM unordered_stanza_queue WHERE stanza_id = ?').get(id) as
				| { process_count: number; stanza_id: string }
				| undefined

		backend.enqueueUnorderedStanza({
			stanzaId: 'MSG-U-1',
			stanzaPayload: Buffer.from([0x01, 0x02]),
			chatJid: '120363044055005321@g.us',
			chatType: 1,
			processCount: 1
		})
		expect(row('MSG-U-1')?.process_count).toBe(1)

		// Re-enqueue of the same id bumps process_count (no duplicate row).
		backend.enqueueUnorderedStanza({ stanzaId: 'MSG-U-1', stanzaPayload: Buffer.from([0x03]) })
		const count = axolotl.prepare('SELECT COUNT(*) AS n FROM unordered_stanza_queue').get() as { n: number }
		expect(count.n).toBe(1)
		expect(row('MSG-U-1')?.process_count).toBe(2)

		// Delete by message id (retry resolved).
		expect(backend.deleteUnorderedStanza('MSG-U-1')).toBe(true)
		expect(row('MSG-U-1')).toBeUndefined()
	})

	it('appends preacks and drains a contiguous prefix', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const remaining = () =>
			(store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM preacks').get() as { n: number }).n

		const id1 = backend.enqueuePreack(Buffer.from([0xa1]))
		backend.enqueuePreack(Buffer.from([0xa2]))
		const id3 = backend.enqueuePreack(Buffer.from([0xa3]))
		expect(remaining()).toBe(3)
		expect(id3).toBeGreaterThan(id1)

		// Drain up to the first id removes only that prefix.
		expect(backend.drainPreacksUpTo(id1)).toBe(1)
		expect(remaining()).toBe(2)

		// Drain up to the last id removes the rest.
		backend.drainPreacksUpTo(id3)
		expect(remaining()).toBe(0)
	})

	it('deletes a single preack by exact id (concurrent-safe, leaves others)', () => {
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const remaining = () =>
			(store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM preacks').get() as { n: number }).n

		const id1 = backend.enqueuePreack(Buffer.from([0xb1]))
		const id2 = backend.enqueuePreack(Buffer.from([0xb2]))
		backend.enqueuePreack(Buffer.from([0xb3]))
		expect(remaining()).toBe(3)

		// Deleting the middle id drops ONLY that row — the earlier (id1) and
		// later (id3) not-yet-sent pre-acks survive (unlike a prefix drain).
		expect(backend.deletePreack(id2)).toBe(true)
		expect(remaining()).toBe(2)
		const ids = (
			store.handle('axolotl.db').prepare('SELECT _id FROM preacks ORDER BY _id').all() as Array<{ _id: number }>
		).map(r => r._id)
		expect(ids).toContain(id1)
		expect(ids).not.toContain(id2)
	})
})
