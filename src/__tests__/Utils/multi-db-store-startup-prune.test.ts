/**
 * Startup-prune policy: transient in-flight tables are wiped every time the
 * store is opened (i.e. on process start), so a crash that skipped the owning
 * backend's teardown clear() can't leave stale rows accumulating across
 * restarts (audit #627/#628/#633). A persistent (source-of-truth) table must
 * survive the reopen — proving the prune is scoped, not a blanket wipe.
 */
import { writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

const LOCK_FILE = '.multi-db-sqlite.lock'

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

	// The session lock is an OS-held EXCLUSIVE SQLite lock. While one store holds
	// it, a SECOND open on the same sessionDir must be REFUSED — no reclaim, no
	// startup-prune clobbering the first store's in-flight rows. (SQLite's
	// in-process lock coordination makes this deterministic same-process; the same
	// fcntl lock also excludes other processes/containers — validated separately
	// on overlay + 9p, incl. auto-release on SIGKILL, which a unit test can't
	// portably kill.)
	it('refuses a second store while the first holds the lock (no reclaim / no theft)', async () => {
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		const second = new MultiDbSqliteStore({ sessionDir: dir })
		try {
			await expect(second.open()).rejects.toThrow(/locked by another live store/)
		} finally {
			second.close()
			first.close()
		}
	})

	// The lock is released on close() (the held EXCLUSIVE transaction rolls back),
	// so a legitimate reopen — the correct reconnect flow: close() then rebuild —
	// succeeds.
	it('releases the lock on close so a reopen succeeds', async () => {
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		first.close()

		const second = new MultiDbSqliteStore({ sessionDir: dir })
		await expect(second.open()).resolves.toBeUndefined()
		try {
			expect(count(second, 'msgstore.db', 'jid')).toBe(0)
		} finally {
			second.close()
		}
	})

	// Migration: pre-upgrade builds wrote a JSON pidfile at the same path. Opened
	// as a SQLite db it raises SQLITE_NOTADB; the store must replace it and take
	// the lock, not crash. (A stale legacy file is the common upgrade case.)
	it('replaces a legacy JSON pidfile lock and opens', async () => {
		writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 1, token: 'legacy' }))
		const store = new MultiDbSqliteStore({ sessionDir: dir })
		await expect(store.open()).resolves.toBeUndefined()
		try {
			expect(count(store, 'msgstore.db', 'jid')).toBe(0)
		} finally {
			store.close()
		}
	})
})
