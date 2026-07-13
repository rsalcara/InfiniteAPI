/**
 * Startup-prune policy: transient in-flight tables are wiped every time the
 * store is opened (i.e. on process start), so a crash that skipped the owning
 * backend's teardown clear() can't leave stale rows accumulating across
 * restarts (audit #627/#628/#633). A persistent (source-of-truth) table must
 * survive the reopen — proving the prune is scoped, not a blanket wipe.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('MultiDbSqliteStore startup prune', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'multi-db-startup-prune-test-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const count = (store: MultiDbSqliteStore, file: Parameters<MultiDbSqliteStore['handle']>[0], table: string) =>
		(store.handle(file).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

	it('wipes transient tables on reopen but keeps persistent ones', async () => {
		// First session: seed one transient row per transient table + one
		// persistent row (jid_map, a source-of-truth mapping) as a control.
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		try {
			first
				.handle('axolotl.db')
				.prepare(
					'INSERT INTO message_base_key (msg_key_remote_jid, msg_key_from_me, msg_key_id, recipient_id, ' +
						'recipient_type, device_id, last_alice_base_key, timestamp) VALUES (?, 0, ?, ?, 0, 0, ?, ?)'
				)
				.run('a@s.whatsapp.net', 'K1', 1, Buffer.from([1]), 1_000)
			first
				.handle('axolotl.db')
				.prepare(
					'INSERT INTO unordered_stanza_queue (stanza_id, stanza_key, stanza_class, stanza_type, stanza_payload, ' +
						'time_sec, create_time_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.run('S1', Buffer.from('k1'), 0, 0, Buffer.from([1]), 1_000, 1_000_000)
			first.handle('axolotl.db').prepare('INSERT INTO preacks (ptn) VALUES (?)').run('p1')
			first.handle('media.db').prepare('INSERT INTO media_job (uuid, job_type) VALUES (?, ?)').run('U1', 1)
			first.handle('sync.db').prepare('INSERT INTO history_sync_companion (message_id) VALUES (?)').run('H1')
			// Persistent control: a jid + jid_map row (source of truth).
			first
				.handle('msgstore.db')
				.prepare("INSERT INTO jid (user, server, raw_string) VALUES ('a', 's.whatsapp.net', 'a@s.whatsapp.net')")
				.run()
			first
				.handle('msgstore.db')
				.prepare('INSERT INTO jid_map (lid_row_id, jid_row_id, sort_id) VALUES (1, 1, 1)')
				.run()

			expect(count(first, 'axolotl.db', 'message_base_key')).toBe(1)
			expect(count(first, 'media.db', 'media_job')).toBe(1)
		} finally {
			first.close()
		}

		// Second session over the SAME directory (simulates a process restart
		// after a crash that skipped teardown).
		const second = new MultiDbSqliteStore({ sessionDir: dir })
		await second.open()
		try {
			// Every transient table was wiped on open …
			expect(count(second, 'axolotl.db', 'message_base_key')).toBe(0)
			expect(count(second, 'axolotl.db', 'unordered_stanza_queue')).toBe(0)
			expect(count(second, 'axolotl.db', 'preacks')).toBe(0)
			expect(count(second, 'media.db', 'media_job')).toBe(0)
			expect(count(second, 'sync.db', 'history_sync_companion')).toBe(0)
			// … but the persistent source-of-truth row survived.
			expect(count(second, 'msgstore.db', 'jid_map')).toBe(1)
		} finally {
			second.close()
		}
	})

	it('rejects a second live owner before it can prune in-flight rows', async () => {
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		const second = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		try {
			first.handle('media.db').prepare('INSERT INTO media_job (uuid, job_type) VALUES (?, ?)').run('LIVE', 1)

			await expect(second.open()).rejects.toThrow(/already owned by process/)
			expect(count(first, 'media.db', 'media_job')).toBe(1)
		} finally {
			second.close()
			first.close()
		}
	})
})
