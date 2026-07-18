/**
 * `TrustedContactsBackend` — relational (PK-jid) storage for TC / "privacy"
 * tokens, the authoritative surface that replaces the signal_kv `__index`
 * enumeration (whose read-merge-write jid list had a lost-update race).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore, TrustedContactsBackend } from '../../Utils/multi-db-sqlite'

describe('TrustedContactsBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'tc-backend-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('round-trips incoming and sent tokens keyed by jid', () => {
		const backend = new TrustedContactsBackend(store.handle('wa.db'))

		backend.setIncoming('46802258641027@lid', Buffer.from([0x04, 0x01, 0x31]), 1_784_050_585)
		const inc = backend.getIncoming('46802258641027@lid')
		expect(inc).not.toBeNull()
		expect(Buffer.from(inc!.token).toString('hex')).toBe('040131')
		expect(inc!.timestamp).toBe(1_784_050_585)

		// real_issue_timestamp = 0 is the "scheduled, not yet server-confirmed" state.
		backend.setSent('56307306467375@lid', 1_773_333_264, 0)
		const sent = backend.getSent('56307306467375@lid')
		expect(sent).toEqual({ sentTimestamp: 1_773_333_264, realIssueTimestamp: 0 })
	})

	it('enumerates jids via the PK table (no __index) and stays race-free on re-set', () => {
		const backend = new TrustedContactsBackend(store.handle('wa.db'))
		backend.setIncoming('46802258641027@lid', Buffer.from([1]), 1_784_050_585)
		backend.setIncoming('185143255945217@lid', Buffer.from([2]), 1_784_049_077)
		backend.setSent('56307306467375@lid', 1_773_333_264, 0)

		expect(backend.listIncomingJids().sort()).toEqual(['185143255945217@lid', '46802258641027@lid'])
		expect(backend.listIncoming().find(r => r.jid === '185143255945217@lid')?.timestamp).toBe(1_784_049_077)
		expect(backend.listSentJids()).toEqual(['56307306467375@lid'])

		// Re-setting the same jid is an atomic UPSERT on the PK — no duplicate row,
		// no shared list to clobber (the race the __index list had).
		backend.setIncoming('46802258641027@lid', Buffer.from([9]), 1_784_050_600)
		expect(backend.listIncomingJids()).toHaveLength(2)
		expect(backend.stats().incomingCount).toBe(2)
		expect(Buffer.from(backend.getIncoming('46802258641027@lid')!.token).toString('hex')).toBe('09')
	})

	it('deletes incoming and sent rows independently', () => {
		const backend = new TrustedContactsBackend(store.handle('wa.db'))
		backend.setIncoming('a@lid', Buffer.from([1]), 1)
		backend.setSent('a@lid', 2, 3)

		expect(backend.deleteIncoming('a@lid')).toBe(true)
		expect(backend.getIncoming('a@lid')).toBeNull()
		expect(backend.getSent('a@lid')).not.toBeNull() // sent row untouched
		expect(backend.deleteSent('a@lid')).toBe(true)
		expect(backend.getSent('a@lid')).toBeNull()
	})

	it('replaces incoming and sent halves atomically', () => {
		const backend = new TrustedContactsBackend(store.handle('wa.db'))
		backend.replace('a@lid', {
			incoming: { token: Buffer.from([1]), timestamp: 10 },
			sent: { sentTimestamp: 20, realIssueTimestamp: 30 }
		})
		store.handle('wa.db').exec(`
			CREATE TRIGGER fail_sent_replace
			BEFORE UPDATE ON wa_trusted_contacts_send
			BEGIN
				SELECT RAISE(ABORT, 'forced sent failure');
			END;
		`)

		try {
			expect(() =>
				backend.replace('a@lid', {
					incoming: { token: Buffer.from([9]), timestamp: 90 },
					sent: { sentTimestamp: 200, realIssueTimestamp: 300 }
				})
			).toThrow('forced sent failure')
			expect(Buffer.from(backend.getIncoming('a@lid')!.token).toString('hex')).toBe('01')
			expect(backend.getSent('a@lid')).toEqual({ sentTimestamp: 20, realIssueTimestamp: 30 })
		} finally {
			store.handle('wa.db').exec('DROP TRIGGER IF EXISTS fail_sent_replace')
		}
	})

	it('persists and clears the cross-file reset marker atomically with wa rows', () => {
		const backend = new TrustedContactsBackend(store.handle('wa.db'))
		backend.setIncoming('a@lid', Buffer.from([1]), 1)
		backend.setSent('a@lid', 2, 3)

		backend.beginClear()
		expect(backend.hasPendingClear()).toBe(true)
		expect(backend.listIncoming()).toEqual([])
		expect(backend.listSentJids()).toEqual([])

		backend.finishClear()
		expect(backend.hasPendingClear()).toBe(false)
	})
})
